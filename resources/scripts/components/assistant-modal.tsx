import { AssistantModalPrimitive } from "@assistant-ui/react";
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "@wordpress/element";

import {
  applyPanelPosition,
  clearPanelPosition,
  getStoredPanelPosition,
  getStoredPanelSize,
} from "./panel-geometry";
import { Thread } from "./Thread";
import { UndoContext, type UndoableAction } from "./UndoContext";

/** A single pending tool approval bubbled up from the runtime adapter. */
export interface PendingApproval {
  toolUseId: string;
  toolName?: string;
  input?: unknown;
  /** Optional hostname surfaced for the "Approve & trust" affordance. */
  trustableHost?: string;
}

export interface AssistantModalProps {
  /** Start a fresh conversation (clears the current thread state). */
  onNewChat: () => void;
  /** Resume a stored conversation by uuid. */
  onLoadConversation: (uuid: string) => void;
  /** Optional system context prepended to the first message. */
  systemContext?: string;
  /** Notified when the user edits the system context. */
  onSystemContextChange: (ctx: string) => void;
  /**
   * Approve pending tool call(s). When called without args, approves all
   * pending; with `{ trustHost: true }` also trusts the surfaced host.
   */
  onApproveToolCall: (opts?: { trustHost?: boolean }) => void;
  /** Deny pending tool call(s). */
  onDenyToolCall: () => void;
  /** Tool calls awaiting user approval. */
  pendingApprovals: PendingApproval[];
  /** Per-tool-call undoable state, keyed by tool-call id. */
  undoableActions?: Record<string, UndoableAction>;
  /** Issue an undo for the given tool-call + audit id. */
  onUndo: ((toolCallId: string, auditId: string) => void) | null;
  /** Retry a failed tool call. */
  onRetry: ((toolCallId: string) => void) | null;
  /** Tool-call ids currently mid-retry; drives the spinner. */
  retryingIds?: Set<string>;
}

// Floating assistant modal for the WP admin.
// Uses assistant-ui primitives for full control over rendering — see
// AssistantModalProps for the wiring surface.
export function AssistantModal({
  onNewChat,
  onLoadConversation,
  systemContext,
  onSystemContextChange,
  onApproveToolCall,
  onDenyToolCall,
  pendingApprovals,
  undoableActions,
  onUndo,
  onRetry,
  retryingIds,
}: AssistantModalProps): JSX.Element {
  const undoContextValue = useMemo(
    () => ({
      undoableActions: undoableActions || {},
      onUndo,
      onRetry,
      retryingIds: retryingIds || new Set<string>(),
      // Tool-call cards detect their "approval required" state by id — assistant-ui
      // doesn't surface requires-action status for external-store parts.
      pendingApprovalIds: new Set<string>(
        (pendingApprovals || []).map((p) => p.toolUseId),
      ),
    }),
    [undoableActions, onUndo, onRetry, retryingIds, pendingApprovals],
  );

  // Persist open/closed state so the panel reopens itself after a full-page
  // wp-admin navigation. Root is uncontrolled (Cmd+K and resume click the
  // trigger), so defaultOpen seeds the initial state on mount and onOpenChange
  // records every subsequent toggle.
  const initialOpen = useMemo(() => {
    try {
      return localStorage.getItem("gds-assistant-open") === "1";
    } catch {
      return false;
    }
  }, []);
  const handleOpenChange = useCallback((open: boolean) => {
    try {
      localStorage.setItem("gds-assistant-open", open ? "1" : "0");
    } catch {
      // Ignore storage failures (private mode, quota).
    }
  }, []);

  // Keyboard shortcut: Cmd+K / Ctrl+K to toggle modal
  // Also open when a conversation is resumed
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Track moved state in React so the --moved class is part of the
  // className prop — React strips DOM classes that aren't in the prop
  // on re-render, which was wiping our override class mid-drag.
  const [isMoved, setIsMoved] = useState<boolean>(
    () => !!getStoredPanelPosition(),
  );

  const panelClassName = useMemo(
    () =>
      `gds-assistant gds-assistant__panel${
        isMoved ? " gds-assistant__panel--moved" : ""
      }`,
    [isMoved],
  );

  // Callback ref: fires every time the panel element mounts (the modal
  // uses a portal + may unmount on close, so a plain useEffect only runs
  // once). Applies the stored size + position whenever a new panel node
  // appears.
  const setPanelRef = useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node;
    if (!node) {
      return;
    }
    const size = getStoredPanelSize();
    if (size) {
      node.style.width = `${size.width}px`;
      node.style.height = `${size.height}px`;
    }
    const pos = getStoredPanelPosition();
    if (pos) {
      // applyPanelPosition sets CSS vars AND tags the wrapper — critical
      // because without the wrapper tag its transform forwards the
      // position: fixed panel off-screen on page reload.
      applyPanelPosition(node, pos.top, pos.left);
    }
  }, []);

  // Drag the panel around by its header. Starts a drag only on empty
  // header space — clicks on buttons inside the header still work
  // normally because they stop propagation naturally.
  const onHeaderMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) {
        return;
      }
      const target = e.target as HTMLElement;
      if (target.closest("button, input, textarea, select, a")) {
        return;
      }

      e.preventDefault();
      const panel = panelRef.current;
      if (!panel) {
        return;
      }

      // Snapshot initial rect + mouse pos, THEN lock our positioning
      // immediately so the panel stays put during the drag (no jump).
      const rect = panel.getBoundingClientRect();
      const startTop = rect.top;
      const startLeft = rect.left;
      const startX = e.clientX;
      const startY = e.clientY;

      // Pin the panel at its current visual location. Flip React state so
      // the --moved class is rendered via the className prop (React would
      // strip a DOM-only class on next render).
      setIsMoved(true);
      applyPanelPosition(panel, startTop, startLeft);

      const clamp = (top: number, left: number) => ({
        top: Math.max(0, Math.min(window.innerHeight - 40, top)),
        left: Math.max(0, Math.min(window.innerWidth - 40, left)),
      });

      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        const { top, left } = clamp(startTop + dy, startLeft + dx);
        applyPanelPosition(panel, top, left);
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        try {
          const r = panel.getBoundingClientRect();
          localStorage.setItem(
            "gds-assistant-panel-position",
            JSON.stringify({ top: r.top, left: r.left }),
          );
        } catch {
          // noop
        }
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [],
  );

  // Reset position/size to defaults (clears both localStorage keys and
  // inline styles). Exposed via a button in the header context menu or
  // can be called from console.
  const resetPanelPosition = useCallback(() => {
    try {
      localStorage.removeItem("gds-assistant-panel-position");
      localStorage.removeItem("gds-assistant-panel-size");
    } catch {
      // noop
    }
    setIsMoved(false);
    const panel = panelRef.current;
    if (panel) {
      clearPanelPosition(panel);
      panel.style.width = "";
      panel.style.height = "";
    }
  }, []);

  // Resize handle drag logic. The handle sits in the TOP-LEFT corner of
  // the panel since the panel is anchored bottom-right — dragging up/left
  // grows outward in both dimensions naturally.
  const onResizeStart = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    const startX = e.clientX;
    const startY = e.clientY;
    const rect = panel.getBoundingClientRect();
    const startW = rect.width;
    const startH = rect.height;

    const onMove = (ev: MouseEvent) => {
      // Anchored bottom-right, so dragging LEFT increases width and
      // dragging UP increases height.
      const dx = startX - ev.clientX;
      const dy = startY - ev.clientY;
      const maxW = window.innerWidth - 48;
      const maxH = window.innerHeight - 120;
      const w = Math.max(320, Math.min(maxW, startW + dx));
      const h = Math.max(400, Math.min(maxH, startH + dy));
      panel.style.width = `${w}px`;
      panel.style.height = `${h}px`;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      try {
        localStorage.setItem(
          "gds-assistant-panel-size",
          JSON.stringify({
            width: panel.offsetWidth,
            height: panel.offsetHeight,
          }),
        );
      } catch {
        // Private browsing etc. — non-fatal.
      }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        triggerRef.current?.click();
      }
    };
    // Open modal when resume event fires
    const resumeHandler = () => {
      // Small delay to let loadConversation complete first
      setTimeout(() => triggerRef.current?.click(), 100);
    };
    window.addEventListener("gds-assistant-resume", resumeHandler);
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      window.removeEventListener("gds-assistant-resume", resumeHandler);
    };
  }, []);

  return (
    <AssistantModalPrimitive.Root
      defaultOpen={initialOpen}
      onOpenChange={handleOpenChange}
    >
      <AssistantModalPrimitive.Trigger
        ref={triggerRef}
        className="gds-assistant gds-assistant__trigger"
      >
        <span className="gds-assistant__trigger-icon">✦</span>
      </AssistantModalPrimitive.Trigger>

      <AssistantModalPrimitive.Content
        ref={setPanelRef}
        className={panelClassName}
        sideOffset={16}
      >
        {/* Resize is a mouse-only affordance for a pure-layout element; the
            panel has dedicated keyboard-reachable size controls in the
            header actions, so the static-interaction warning doesn't apply. */}
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
        <div
          className="gds-assistant__resize-handle"
          onMouseDown={onResizeStart}
          title="Drag to resize"
          aria-label="Resize chat panel"
        />
        <UndoContext.Provider value={undoContextValue}>
          <Thread
            onNewChat={onNewChat}
            onLoadConversation={onLoadConversation}
            systemContext={systemContext}
            onSystemContextChange={onSystemContextChange}
            onApproveToolCall={onApproveToolCall}
            onDenyToolCall={onDenyToolCall}
            pendingApprovals={pendingApprovals}
            onHeaderMouseDown={onHeaderMouseDown}
            resetPanelPosition={resetPanelPosition}
            onClose={() => triggerRef.current?.click()}
          />
        </UndoContext.Provider>
      </AssistantModalPrimitive.Content>
    </AssistantModalPrimitive.Root>
  );
}
