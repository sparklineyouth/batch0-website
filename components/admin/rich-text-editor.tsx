"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Bold,
  Italic,
  Link2,
  Link2Off,
  List,
  ListOrdered,
  Quote,
  Minus,
  Heading1,
  Heading2,
  Code2,
  Braces,
  Undo2,
  Redo2,
  Eraser,
} from "lucide-react";
import { sanitizeEmailHtml } from "@/lib/email/sanitize";
import type { VariableDef } from "@/lib/email/vars";

/**
 * The email body editor.
 *
 * A `contentEditable` div with a toolbar, no dependency. That's a deliberate
 * choice rather than a shortcut: the target output is email HTML, which is a
 * far smaller grammar than the web — a dozen tags, inline styles only, no
 * classes, no embeds. Every rich-text library worth using is built to produce
 * web HTML and then has to be configured back down to this, and would ship
 * more bytes doing it than the whole editor below.
 *
 * `document.execCommand` is formally deprecated and has no replacement that
 * is implemented anywhere. Every browser still supports it, and it brings
 * native undo/redo with it, which is the part that would be genuinely painful
 * to rebuild.
 *
 * Two guarantees the rest of the feature leans on:
 *  - what leaves this component is sanitized (the server sanitizes again —
 *    this pass is so the source tab shows the admin what will actually save)
 *  - `{{merge_tags}}` survive editing intact
 */

export type RichTextEditorProps = {
  value: string;
  onChange: (html: string) => void;
  /** Offered in the "Insert variable" menu. */
  variables?: VariableDef[];
  placeholder?: string;
  minHeight?: number;
  disabled?: boolean;
};

type Mode = "rich" | "source";

export function RichTextEditor({
  value,
  onChange,
  variables = [],
  placeholder = "Write the email…",
  minHeight = 280,
  disabled = false,
}: RichTextEditorProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>("rich");
  const [varsOpen, setVarsOpen] = useState(false);
  const menuId = useId();

  // The selection at the moment a toolbar button was pressed. Clicking the
  // toolbar blurs the editable area, which collapses the selection — without
  // stashing it first, "insert link" would apply to nothing.
  const savedRange = useRef<Range | null>(null);

  /**
   * Write the incoming value into the DOM only when it genuinely differs.
   *
   * A contentEditable is uncontrolled by nature: setting innerHTML on every
   * keystroke would move the caret to the start of the field on every
   * character typed. The comparison is what makes external updates (loading a
   * template, switching back from the source tab) work without that.
   */
  useEffect(() => {
    if (mode !== "rich") return;
    const el = ref.current;
    if (!el) return;
    if (el.innerHTML !== value) el.innerHTML = value || "";
  }, [value, mode]);

  const emit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    onChange(el.innerHTML);
  }, [onChange]);

  function saveSelection() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && ref.current?.contains(sel.anchorNode)) {
      savedRange.current = sel.getRangeAt(0).cloneRange();
    }
  }

  function restoreSelection() {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const range = savedRange.current;
    if (!range) return;
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  function exec(command: string, arg?: string) {
    if (disabled) return;
    restoreSelection();
    document.execCommand(command, false, arg);
    emit();
  }

  function insertHtml(html: string) {
    if (disabled) return;
    restoreSelection();
    document.execCommand("insertHTML", false, html);
    emit();
  }

  function addLink() {
    saveSelection();
    const url = window.prompt(
      "Link URL — https://…, mailto:…, or a {{variable}}",
      "https://",
    );
    if (!url) return;
    const trimmed = url.trim();
    if (!trimmed || trimmed === "https://") return;
    exec("createLink", trimmed);
  }

  function insertVariable(key: string) {
    setVarsOpen(false);
    insertHtml(`{{${key}}}`);
  }

  const toolbarDisabled = disabled || mode === "source";

  return (
    <div className="rounded-lg border border-line bg-paper">
      <div className="flex flex-wrap items-center gap-1 border-b border-line px-2 py-1.5">
        <ToolButton
          label="Bold"
          onClick={() => exec("bold")}
          disabled={toolbarDisabled}
        >
          <Bold className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          label="Italic"
          onClick={() => exec("italic")}
          disabled={toolbarDisabled}
        >
          <Italic className="h-4 w-4" />
        </ToolButton>
        <Divider />
        <ToolButton
          label="Heading"
          onClick={() => exec("formatBlock", "<h1>")}
          disabled={toolbarDisabled}
        >
          <Heading1 className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          label="Subheading"
          onClick={() => exec("formatBlock", "<h2>")}
          disabled={toolbarDisabled}
        >
          <Heading2 className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          label="Paragraph"
          onClick={() => exec("formatBlock", "<p>")}
          disabled={toolbarDisabled}
        >
          <span className="text-xs font-semibold">¶</span>
        </ToolButton>
        <Divider />
        <ToolButton
          label="Bullet list"
          onClick={() => exec("insertUnorderedList")}
          disabled={toolbarDisabled}
        >
          <List className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          label="Numbered list"
          onClick={() => exec("insertOrderedList")}
          disabled={toolbarDisabled}
        >
          <ListOrdered className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          label="Quote"
          onClick={() => exec("formatBlock", "<blockquote>")}
          disabled={toolbarDisabled}
        >
          <Quote className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          label="Divider"
          onClick={() => insertHtml("<hr>")}
          disabled={toolbarDisabled}
        >
          <Minus className="h-4 w-4" />
        </ToolButton>
        <Divider />
        <ToolButton label="Add link" onClick={addLink} disabled={toolbarDisabled}>
          <Link2 className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          label="Remove link"
          onClick={() => exec("unlink")}
          disabled={toolbarDisabled}
        >
          <Link2Off className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          label="Clear formatting"
          onClick={() => exec("removeFormat")}
          disabled={toolbarDisabled}
        >
          <Eraser className="h-4 w-4" />
        </ToolButton>
        <Divider />
        <ToolButton
          label="Undo"
          onClick={() => exec("undo")}
          disabled={toolbarDisabled}
        >
          <Undo2 className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          label="Redo"
          onClick={() => exec("redo")}
          disabled={toolbarDisabled}
        >
          <Redo2 className="h-4 w-4" />
        </ToolButton>

        <div className="relative ml-auto flex items-center gap-1">
          {variables.length > 0 && (
            <>
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={varsOpen}
                aria-controls={menuId}
                onMouseDown={(e) => {
                  // mousedown, not click: by the time click fires the editor
                  // has already lost its selection.
                  e.preventDefault();
                  saveSelection();
                  setVarsOpen((o) => !o);
                }}
                disabled={toolbarDisabled}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line px-2 text-xs font-medium text-ink-soft transition-none hover:bg-wash hover:text-ink active:scale-[0.98] disabled:opacity-40"
              >
                <Braces className="h-3.5 w-3.5" />
                Insert variable
              </button>
              {varsOpen && (
                <div
                  id={menuId}
                  role="menu"
                  className="absolute right-0 top-9 z-20 max-h-72 w-72 overflow-y-auto rounded-lg border border-line bg-paper p-1 shadow-lg"
                >
                  {variables.map((v) => (
                    <button
                      key={v.key}
                      type="button"
                      role="menuitem"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        insertVariable(v.key);
                      }}
                      className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-wash"
                    >
                      <span className="font-mono text-xs text-phosphor-ink">
                        {`{{${v.key}}}`}
                      </span>
                      <span className="ml-2 text-xs text-ink-soft">{v.label}</span>
                      {v.required && (
                        <span className="ml-1 text-[10px] uppercase tracking-wide text-amber-600">
                          required
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          <button
            type="button"
            onClick={() => {
              // Leaving the source tab is the moment to sanitize: whatever
              // the admin hand-wrote becomes what the rich view can show,
              // so the two tabs can't disagree about the content.
              if (mode === "source") onChange(sanitizeEmailHtml(value));
              setMode(mode === "rich" ? "source" : "rich");
            }}
            disabled={disabled}
            className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-none active:scale-[0.98] disabled:opacity-40 ${
              mode === "source"
                ? "border-phosphor/50 bg-phosphor/10 text-phosphor-ink"
                : "border-line text-ink-soft hover:bg-wash hover:text-ink"
            }`}
          >
            <Code2 className="h-3.5 w-3.5" />
            HTML
          </button>
        </div>
      </div>

      {mode === "rich" ? (
        <div
          ref={ref}
          role="textbox"
          aria-multiline="true"
          aria-label="Email body"
          contentEditable={!disabled}
          suppressContentEditableWarning
          data-placeholder={placeholder}
          onInput={emit}
          onBlur={() => {
            saveSelection();
            emit();
          }}
          onKeyUp={saveSelection}
          onMouseUp={saveSelection}
          onPaste={(e) => {
            // Pasting from Google Docs or a browser drags in a payload of
            // spans, classes, and fonts. Take the plain text and let the
            // toolbar do the formatting — the alternative is an email body
            // full of markup the sanitizer will strip anyway, which reads to
            // the admin as "my formatting randomly disappeared on save".
            e.preventDefault();
            const text = e.clipboardData.getData("text/plain");
            const html = text
              .split(/\n{2,}/)
              .map(
                (p) =>
                  `<p>${p
                    .replace(/&/g, "&amp;")
                    .replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;")
                    .replace(/\n/g, "<br>")}</p>`,
              )
              .join("");
            document.execCommand("insertHTML", false, html);
            emit();
          }}
          className="email-editor min-h-[var(--editor-min)] w-full px-4 py-3 text-sm leading-relaxed text-ink outline-none focus-visible:ring-0"
          style={{ ["--editor-min" as any]: `${minHeight}px` }}
        />
      ) : (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          spellCheck={false}
          className="w-full resize-y bg-transparent px-4 py-3 font-mono text-xs leading-relaxed text-ink outline-none"
          style={{ minHeight }}
        />
      )}

      {/*
        Styling for the editable area. It's scoped with `.email-editor` and
        mirrors BODY_TAG_STYLES in lib/email/layout.ts, so what the admin sees
        while typing is close to what the renderer will inline at send time —
        a contentEditable with no styles of its own shows h1 and p at the same
        size, which makes hierarchy impossible to judge.
      */}
      <style jsx global>{`
        .email-editor:empty::before {
          content: attr(data-placeholder);
          color: currentColor;
          opacity: 0.4;
          pointer-events: none;
        }
        .email-editor h1 {
          font-size: 1.35rem;
          font-weight: 700;
          line-height: 1.25;
          margin: 0 0 0.5rem;
        }
        .email-editor h2 {
          font-size: 1.1rem;
          font-weight: 700;
          line-height: 1.3;
          margin: 1.25rem 0 0.4rem;
        }
        .email-editor p {
          margin: 0 0 0.75rem;
        }
        .email-editor ul,
        .email-editor ol {
          margin: 0 0 0.75rem;
          padding-left: 1.35rem;
        }
        .email-editor ul {
          list-style: disc;
        }
        .email-editor ol {
          list-style: decimal;
        }
        .email-editor li {
          margin: 0 0 0.25rem;
        }
        .email-editor blockquote {
          margin: 1rem 0;
          padding: 0.5rem 0.9rem;
          border-left: 3px solid rgba(128, 128, 128, 0.35);
          opacity: 0.85;
        }
        .email-editor a {
          color: #b8860b;
          text-decoration: underline;
        }
        .email-editor hr {
          margin: 1.25rem 0;
          border: 0;
          border-top: 1px solid rgba(128, 128, 128, 0.3);
        }
      `}</style>
    </div>
  );
}

function ToolButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      // mousedown so the editor keeps its selection; click fires after blur.
      onMouseDown={(e) => {
        e.preventDefault();
        onClick();
      }}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-soft transition-none hover:bg-wash hover:text-ink active:scale-[0.9] disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-5 w-px bg-line" aria-hidden />;
}
