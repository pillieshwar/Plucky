import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { byAgent, markLabel, type Who } from "../lib/agents";
import type { AgentChange, Task } from "../lib/types";

/** What lists need to mark agents' tasks: each task's latest agent change, and Undo in the Agents view. */
export interface AgentMarksValue {
  latest: Map<number, AgentChange>;
  now: Date;
  /** Set in the Agents view: undo what agents did to this task. */
  undo?: (taskId: number) => void;
}
export const AgentMarks = createContext<AgentMarksValue>({ latest: new Map(), now: new Date() });

/** "Claude scheduled", for a task an agent touched (and Undo in the Agents view). */
export function AgentMark({ task }: { task: Task }) {
  const m = useContext(AgentMarks);
  if (!byAgent(task, m.now)) return null;
  const c = m.latest.get(task.id);
  return (
    <>
      <span className="agent-mark">
        <AgentIcon size={10} />
        {c ? markLabel(c) : "By an agent"}
      </span>
      {m.undo && (
        <button type="button" className="agent-undo" data-nodrag onClick={(e) => { e.stopPropagation(); m.undo!(task.id); }} title={c?.summary}>
          Undo
        </button>
      )}
    </>
  );
}

export function useIsAgentTask(task: Task): boolean {
  const m = useContext(AgentMarks);
  return byAgent(task, m.now);
}

const PersonIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
    <circle cx="8" cy="5.5" r="2.8" />
    <path d="M2.8 14c.6-2.8 2.7-4.3 5.2-4.3s4.6 1.5 5.2 4.3" />
  </svg>
);

export const AgentIcon = ({ size = 13 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
    <path d="M8 1.8l1.4 3.6 3.8.4-2.9 2.5.9 3.8L8 10.1l-3.2 2 .9-3.8L2.8 5.8l3.8-.4z" />
  </svg>
);

/**
 * You · All · Agents, in the header: whose tasks the lists show. "Agents" is
 * what AI apps added or changed in the last 7 days. With agents not set up,
 * it offers to set them up instead of showing an empty list.
 */
export function WhoSwitch({
  who,
  onWho,
  agentCount,
  setUp,
  onSetUp,
}: {
  who: Who;
  onWho: (w: Who) => void;
  agentCount: number;
  setUp: boolean;
  onSetUp: () => void;
}) {
  const opt = (w: Who, label: string, extra?: ReactNode, icon?: ReactNode) => (
    <button
      type="button"
      role="radio"
      aria-checked={who === w}
      className={who === w ? "who-opt on" : "who-opt"}
      onClick={() => (w === "agents" && !setUp ? onSetUp() : onWho(w))}
    >
      {icon}
      {label}
      {extra}
    </button>
  );
  return (
    <div className={who === "agents" ? "who-switch agents" : "who-switch"} role="radiogroup" aria-label="Show tasks from">
      {opt("you", "You", null, <PersonIcon />)}
      {opt("all", "All")}
      {opt(
        "agents",
        "Agents",
        !setUp ? <span className="who-setup">Set up</span> : agentCount > 0 && who !== "agents" ? <span className="who-count">{agentCount}</span> : null,
        <AgentIcon />,
      )}
    </div>
  );
}

/** Agents aren't on yet: what they'd do, and where to turn them on. */
export function AgentsSetUpDialog({ onSetUp, onClose }: { onSetUp: () => void; onClose: () => void }) {
  const go = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    go.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const steps: [string, string][] = [
    ["Turn on AI agents", "One switch, on this Mac only."],
    ["Connect your AI app", "One click adds TodoCity to Claude, Cursor, VS Code and more."],
    ["Choose how much they can do", "Add tasks for your OK, or full access to plan and tidy for you."],
  ];
  return (
    <div className="who-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="who-dialog" role="dialog" aria-modal="true" aria-labelledby="who-dialog-title">
        <span className="who-dialog-icon" aria-hidden>
          <AgentIcon size={20} />
        </span>
        <h2 id="who-dialog-title">Let your AI apps help with your tasks</h2>
        <p>Claude, Cursor and other AI apps on this Mac can add tasks for you, plan your day and tidy your Inbox. Everything they do shows up here, under Agents.</p>
        <ol>
          {steps.map(([t, d], i) => (
            <li key={t}>
              <span className="who-step">{i + 1}</span>
              <span>
                <b>{t}</b>
                <small>{d}</small>
              </span>
            </li>
          ))}
        </ol>
        <div className="who-dialog-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Not now
          </button>
          <button type="button" className="primary" ref={go} onClick={onSetUp}>
            Set up AI agents
          </button>
        </div>
      </div>
    </div>
  );
}
