"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, Select, FieldError } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { ConfirmDialog } from "@/components/ui/dialog";
import { getActionError } from "@/lib/action-error";
import { CATEGORIES, AUTHORS, AUTHOR_KEYS, slugify } from "@/lib/blog-shared";
import {
  saveBlogPost,
  deleteBlogPost,
  renderBlogPreview,
  type BlogPostInput,
} from "./actions";

// The editor state mirrors BlogPostInput, except tags are edited as a single
// comma-separated string for a friendlier text field.
type FormState = Omit<BlogPostInput, "tags"> & { tagsText: string };

export function BlogEditor({ initial }: { initial: BlogPostInput }) {
  const router = useRouter();
  const [v, setV] = useState<FormState>({
    ...initial,
    tagsText: initial.tags.join(", "),
  });
  // Whether the slug has been hand-edited; if not, it tracks the title.
  const [slugTouched, setSlugTouched] = useState(Boolean(initial.id));
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [previewHtml, setPreviewHtml] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [tab, setTab] = useState<"write" | "preview">("write");

  function set<K extends keyof FormState>(k: K, val: FormState[K]) {
    setV((p) => ({ ...p, [k]: val }));
  }

  function onTitle(next: string) {
    setV((p) => ({
      ...p,
      title: next,
      slug: slugTouched ? p.slug : slugify(next),
    }));
  }

  // Debounced live preview through the real server-side markdown pipeline, so
  // the admin sees exactly what will ship.
  const bodyRef = useRef(v.body);
  bodyRef.current = v.body;
  useEffect(() => {
    let cancelled = false;
    setPreviewing(true);
    const t = setTimeout(async () => {
      try {
        const html = await renderBlogPreview(bodyRef.current);
        if (!cancelled) setPreviewHtml(html);
      } catch {
        /* preview is best-effort */
      } finally {
        if (!cancelled) setPreviewing(false);
      }
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [v.body]);

  function toInput(): BlogPostInput {
    const { tagsText, ...rest } = v;
    return {
      ...rest,
      slug: v.slug.trim(),
      tags: tagsText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      updated_on: v.updated_on || null,
    };
  }

  function submit(nextStatus?: "draft" | "published") {
    setError(undefined);
    const payload = nextStatus ? { ...toInput(), status: nextStatus } : toInput();
    start(async () => {
      try {
        const { id } = await saveBlogPost(payload);
        router.push("/admin/blog");
        router.refresh();
        // Keep the id in case the router stays (e.g. validation on next edit).
        void id;
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  function onDelete() {
    if (!v.id) return;
    setError(undefined);
    start(async () => {
      try {
        await deleteBlogPost(v.id!);
        router.push("/admin/blog");
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
        setConfirmDelete(false);
      }
    });
  }

  const wordCount = v.body.trim() ? v.body.trim().split(/\s+/).length : 0;
  const readMins = Math.max(1, Math.round(wordCount / 225));

  return (
    <div className="space-y-6">
      {/* Title + slug */}
      <div className="grid gap-4">
        <div>
          <Label htmlFor="title" required>
            Title
          </Label>
          <Input
            id="title"
            value={v.title}
            onChange={(e) => onTitle(e.target.value)}
            placeholder="How to name your first startup"
            required
          />
        </div>
        <div>
          <Label htmlFor="slug" required>
            Slug
          </Label>
          <div className="flex items-center gap-2">
            <span className="whitespace-nowrap font-mono text-xs text-ink-faint">
              /blog/
            </span>
            <Input
              id="slug"
              value={v.slug}
              onChange={(e) => {
                setSlugTouched(true);
                set("slug", slugify(e.target.value));
              }}
              placeholder="how-to-name-your-first-startup"
              className="font-mono"
            />
          </div>
          <p className="mt-1 text-xs text-ink-faint">
            Lowercase letters, numbers, and hyphens. This is the permanent URL —
            changing it after publishing breaks existing links.
          </p>
        </div>
      </div>

      {/* Meta grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <Label>Status</Label>
          <Select
            value={v.status}
            onChange={(e) => set("status", e.target.value as FormState["status"])}
          >
            <option value="draft">Draft (hidden)</option>
            <option value="published">Published (live)</option>
          </Select>
        </div>
        <div>
          <Label>Category</Label>
          <Select
            value={v.category}
            onChange={(e) => set("category", e.target.value as FormState["category"])}
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Author</Label>
          <Select
            value={v.author_key}
            onChange={(e) =>
              set("author_key", e.target.value as FormState["author_key"])
            }
          >
            {AUTHOR_KEYS.map((k) => (
              <option key={k} value={k}>
                {AUTHORS[k].name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="published_on">Publish date</Label>
          <Input
            id="published_on"
            type="date"
            value={v.published_on}
            onChange={(e) => set("published_on", e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="updated_on">Updated date</Label>
          <Input
            id="updated_on"
            type="date"
            value={v.updated_on ?? ""}
            onChange={(e) => set("updated_on", e.target.value || null)}
          />
          <p className="mt-1 text-xs text-ink-faint">Optional — defaults to publish date.</p>
        </div>
        <div className="flex items-end">
          <div className="w-full">
            <Toggle
              label="Featured"
              checked={v.featured}
              onChange={(next) => set("featured", next)}
            />
          </div>
        </div>
      </div>

      {/* Description + excerpt + tags */}
      <div className="grid gap-4">
        <div>
          <Label htmlFor="description" required>
            Meta description (SEO)
          </Label>
          <Textarea
            id="description"
            rows={2}
            value={v.description}
            onChange={(e) => set("description", e.target.value)}
            placeholder="The one- to two-sentence summary search engines show. ~150 characters."
          />
          <p className="mt-1 text-xs text-ink-faint">
            {v.description.trim().length} characters
          </p>
        </div>
        <div>
          <Label htmlFor="excerpt">List excerpt</Label>
          <Textarea
            id="excerpt"
            rows={2}
            value={v.excerpt}
            onChange={(e) => set("excerpt", e.target.value)}
            placeholder="Optional teaser shown on the blog index. Falls back to the description."
          />
        </div>
        <div>
          <Label htmlFor="tags">Tags</Label>
          <Input
            id="tags"
            value={v.tagsText}
            onChange={(e) => set("tagsText", e.target.value)}
            placeholder="naming, branding, startup basics"
          />
          <p className="mt-1 text-xs text-ink-faint">Comma-separated.</p>
        </div>
      </div>

      {/* Body + live preview */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <Label>Body (Markdown)</Label>
          <div className="flex items-center gap-3 text-xs text-ink-faint">
            <span>
              {wordCount} words · {readMins} min read
            </span>
            <div className="inline-flex overflow-hidden rounded-md border border-line lg:hidden">
              <button
                type="button"
                onClick={() => setTab("write")}
                className={`px-2.5 py-1 ${tab === "write" ? "bg-phosphor text-on-phosphor" : "text-ink-soft"}`}
              >
                Write
              </button>
              <button
                type="button"
                onClick={() => setTab("preview")}
                className={`px-2.5 py-1 ${tab === "preview" ? "bg-phosphor text-on-phosphor" : "text-ink-soft"}`}
              >
                Preview
              </button>
            </div>
          </div>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className={tab === "preview" ? "hidden lg:block" : ""}>
            <Textarea
              value={v.body}
              onChange={(e) => set("body", e.target.value)}
              rows={26}
              className="min-h-[36rem] font-mono text-[13px] leading-[1.6]"
              placeholder={"**Answer the question in the first bold sentence.**\n\n## A section heading\n\nWrite in Markdown. Link to other posts like [this](/blog/what-is-an-mvp)."}
            />
          </div>
          <div className={tab === "write" ? "hidden lg:block" : ""}>
            <div className="relative min-h-[36rem] overflow-auto rounded-md border border-line bg-paper px-5 py-4">
              {previewing && (
                <span className="absolute right-3 top-3 font-mono text-[11px] text-ink-faint">
                  rendering…
                </span>
              )}
              {previewHtml ? (
                <div
                  className="blog-prose"
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                />
              ) : (
                <p className="text-sm text-ink-faint">
                  Live preview appears here as you type.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {error && <FieldError>{error}</FieldError>}

      {/* Actions */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
        <div className="flex items-center gap-3">
          {v.id && (
            <Button
              type="button"
              variant="danger"
              onClick={() => setConfirmDelete(true)}
              disabled={pending}
            >
              Delete
            </Button>
          )}
          {v.id && v.status === "published" && (
            <Link
              href={`/blog/${v.slug}`}
              target="_blank"
              className="text-sm text-ink-soft hover:text-ink"
            >
              View live →
            </Link>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => router.back()} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            onClick={() => submit("draft")}
            disabled={pending}
          >
            {pending ? "Saving…" : "Save draft"}
          </Button>
          <Button onClick={() => submit("published")} disabled={pending}>
            {pending ? "Saving…" : "Publish"}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this post?"
        description={
          <p>
            <span className="text-ink">{v.title || v.slug}</span> will be
            permanently removed from the blog. This cannot be undone.
          </p>
        }
        confirmLabel="Delete"
        destructive
        pending={pending}
        onConfirm={onDelete}
        onCancel={() => !pending && setConfirmDelete(false)}
      />
    </div>
  );
}
