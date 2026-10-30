//! Where TodoCity keeps its data on disk.
//!
//! The folder was `app.pluck.desktop` (the bundle identifier, from when the
//! app was called Pluck). It is now `TodoCity`. The bundle identifier itself
//! stays `app.pluck.desktop`, so macOS permissions, the Keychain items and
//! login items carry over untouched; only the folder moves.
//!
//! [`settle`] runs once at launch, before anything opens a file in the folder:
//!
//! - The old folder is moved to the new name in one `rename` (same disk, so it
//!   is instant and either fully done or not done at all).
//! - The old name is left behind as a link to the new folder, so an older
//!   version (after a downgrade, or anything else holding the old path) still
//!   finds the same data.
//! - Nothing is ever deleted or copied. If anything goes wrong, TodoCity keeps
//!   using whichever folder already holds the data.

use std::io;
use std::path::{Path, PathBuf};

/// The folder name before the rename (the bundle identifier).
pub const OLD_NAME: &str = "app.pluck.desktop";
/// The folder name from 0.4.61 on.
pub const NEW_NAME: &str = "TodoCity";

/// What [`settle`] did, for the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The new folder was already in place.
    AlreadyMoved,
    /// The old folder was moved to the new name.
    Moved,
    /// A first launch: the new folder was made.
    Created,
    /// The move couldn't happen; TodoCity keeps using the old folder.
    KeptOld(String),
    /// Both names held separate data (an older version recreated the old
    /// folder after the link was removed). The new folder is used and the old
    /// one is left as it is.
    BothExist,
}

/// The data folder to use, plus what happened. `parent` is the folder that
/// holds both names (`~/Library/Application Support` on a Mac).
pub fn settle(parent: &Path) -> (PathBuf, Outcome) {
    let old = parent.join(OLD_NAME);
    let new = parent.join(NEW_NAME);

    if is_real_dir(&new) {
        let outcome = if is_real_dir(&old) {
            Outcome::BothExist
        } else {
            if !exists_or_link(&old) {
                link(&new, &old);
            }
            Outcome::AlreadyMoved
        };
        return (new, outcome);
    }

    if exists_or_link(&new) {
        // Something that isn't a folder sits at the new name (a stray file or
        // link). Leave it alone and keep the old folder.
        return keep_old(old, "something else is already called TodoCity");
    }

    if is_real_dir(&old) {
        return match std::fs::rename(&old, &new) {
            Ok(()) => {
                link(&new, &old);
                (new, Outcome::Moved)
            }
            Err(e) => keep_old(old, &format!("could not move the data folder: {e}")),
        };
    }

    if exists_or_link(&old) {
        // The old name is already a link (made by hand, or pointing at another
        // disk). Follow it as before.
        return keep_old(old, "the old data folder is a link; using it as is");
    }

    match std::fs::create_dir_all(&new) {
        Ok(()) => {
            link(&new, &old);
            (new, Outcome::Created)
        }
        Err(e) => keep_old(old, &format!("could not make the data folder: {e}")),
    }
}

/// The data folder for a process that must not move anything (the `--mcp`
/// helper): the new folder if it's there, else the old one.
pub fn locate(parent: &Path) -> PathBuf {
    let new = parent.join(NEW_NAME);
    if is_real_dir(&new) {
        new
    } else {
        parent.join(OLD_NAME)
    }
}

fn keep_old(old: PathBuf, why: &str) -> (PathBuf, Outcome) {
    (old, Outcome::KeptOld(why.to_string()))
}

/// A real directory, not a link to one.
fn is_real_dir(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir())
}

/// Anything at all at `p`, including a dangling link.
fn exists_or_link(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok()
}

/// Leaves `at` as a relative link to `target` (both in the same folder), so
/// it keeps working if the home folder moves. Best effort: the new version
/// doesn't need it.
fn link(target: &Path, at: &Path) {
    let Some(name) = target.file_name() else {
        return;
    };
    if let Err(e) = symlink(Path::new(name), at) {
        log::warn!("could not leave a link at {}: {e}", at.display());
    }
}

#[cfg(unix)]
fn symlink(target: &Path, at: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, at)
}

#[cfg(windows)]
fn symlink(target: &Path, at: &Path) -> io::Result<()> {
    std::os::windows::fs::symlink_dir(target, at)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(p: &Path, s: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, s).unwrap();
    }

    fn read(p: &Path) -> String {
        fs::read_to_string(p).unwrap()
    }

    fn is_link(p: &Path) -> bool {
        fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink())
    }

    #[test]
    fn fresh_install_makes_the_new_folder_and_a_link() {
        let dir = tempfile::tempdir().unwrap();
        let (path, outcome) = settle(dir.path());
        assert_eq!(outcome, Outcome::Created);
        assert_eq!(path, dir.path().join(NEW_NAME));
        assert!(is_real_dir(&path));
        assert!(is_link(&dir.path().join(OLD_NAME)));
    }

    #[test]
    fn upgrade_moves_everything_and_old_path_still_works() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join(OLD_NAME);
        write(&old.join("tasks.db"), "tasks");
        write(&old.join("tasks.db-wal"), "wal");
        write(&old.join("backups/tasks-2026-10-28.db"), "backup");
        write(&old.join("models/m.gguf"), "model");
        write(&old.join("settings.json"), "{}");
        write(&old.join("sync.key"), "key");

        let (path, outcome) = settle(dir.path());
        assert_eq!(outcome, Outcome::Moved);
        assert_eq!(path, dir.path().join(NEW_NAME));
        assert!(is_real_dir(&path));
        assert_eq!(read(&path.join("tasks.db")), "tasks");
        assert_eq!(read(&path.join("tasks.db-wal")), "wal");
        assert_eq!(read(&path.join("backups/tasks-2026-10-28.db")), "backup");
        assert_eq!(read(&path.join("models/m.gguf")), "model");
        assert_eq!(read(&path.join("sync.key")), "key");

        // An older version reading the old path sees the same files…
        assert!(is_link(&old));
        assert_eq!(read(&old.join("tasks.db")), "tasks");
        // …and what it writes lands in the new folder.
        fs::write(old.join("tasks.db"), "written by 0.4.60").unwrap();
        assert_eq!(read(&path.join("tasks.db")), "written by 0.4.60");
    }

    #[test]
    fn second_launch_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join(OLD_NAME).join("tasks.db"), "tasks");
        settle(dir.path());
        let (path, outcome) = settle(dir.path());
        assert_eq!(outcome, Outcome::AlreadyMoved);
        assert_eq!(read(&path.join("tasks.db")), "tasks");
        assert!(is_link(&dir.path().join(OLD_NAME)));
    }

    #[test]
    fn stopped_between_move_and_link_finishes_next_launch() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join(NEW_NAME).join("tasks.db"), "tasks");
        let (path, outcome) = settle(dir.path());
        assert_eq!(outcome, Outcome::AlreadyMoved);
        assert_eq!(read(&path.join("tasks.db")), "tasks");
        assert!(is_link(&dir.path().join(OLD_NAME)));
    }

    #[test]
    fn downgrade_then_upgrade_keeps_the_same_data() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join(OLD_NAME);
        write(&old.join("tasks.db"), "v1");
        settle(dir.path());
        // An older version runs and writes through the link.
        fs::write(old.join("tasks.db"), "v2 from the older version").unwrap();
        let (path, outcome) = settle(dir.path());
        assert_eq!(outcome, Outcome::AlreadyMoved);
        assert_eq!(read(&path.join("tasks.db")), "v2 from the older version");
    }

    #[test]
    fn both_folders_real_uses_new_and_touches_neither() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join(NEW_NAME).join("tasks.db"), "new");
        write(&dir.path().join(OLD_NAME).join("tasks.db"), "old");
        let (path, outcome) = settle(dir.path());
        assert_eq!(outcome, Outcome::BothExist);
        assert_eq!(read(&path.join("tasks.db")), "new");
        assert_eq!(read(&dir.path().join(OLD_NAME).join("tasks.db")), "old");
    }

    #[test]
    fn a_file_called_todocity_keeps_the_old_folder() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join(NEW_NAME), "not a folder");
        write(&dir.path().join(OLD_NAME).join("tasks.db"), "tasks");
        let (path, outcome) = settle(dir.path());
        assert!(matches!(outcome, Outcome::KeptOld(_)));
        assert_eq!(path, dir.path().join(OLD_NAME));
        assert_eq!(read(&path.join("tasks.db")), "tasks");
    }

    #[test]
    fn old_name_already_a_link_elsewhere_is_followed() {
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = dir.path().join("external-disk");
        write(&elsewhere.join("tasks.db"), "tasks");
        symlink(&elsewhere, &dir.path().join(OLD_NAME)).unwrap();
        let (path, outcome) = settle(dir.path());
        assert!(matches!(outcome, Outcome::KeptOld(_)));
        assert_eq!(read(&path.join("tasks.db")), "tasks");
        assert!(!dir.path().join(NEW_NAME).exists());
    }

    #[test]
    fn locate_never_moves_anything() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join(OLD_NAME).join("tasks.db"), "tasks");
        assert_eq!(locate(dir.path()), dir.path().join(OLD_NAME));
        assert!(is_real_dir(&dir.path().join(OLD_NAME)));
        settle(dir.path());
        assert_eq!(locate(dir.path()), dir.path().join(NEW_NAME));
    }
}
