import json, urllib.request
H = {"User-Agent": "plucky-ci (github.com/pillieshwar/Plucky)"}
def get(u):
    return json.load(urllib.request.urlopen(urllib.request.Request(u, headers=H)))
for v in get("https://crates.io/api/v1/crates/zip/versions")["versions"][:14]:
    print("::notice::zip", v["num"], "YANKED" if v["yanked"] else "ok", v["created_at"][:10])
ups = get("https://crates.io/api/v1/crates/tauri-plugin-updater/versions")["versions"][:4]
for v in ups:
    deps = get(f"https://crates.io/api/v1/crates/tauri-plugin-updater/{v['num']}/dependencies")["dependencies"]
    z = [d["req"] for d in deps if d["crate_id"] == "zip"]
    print("::notice::updater", v["num"], "YANKED" if v["yanked"] else "ok", v["created_at"][:10], "zip", z)
