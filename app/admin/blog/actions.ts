"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { renderMarkdown, listFileSlugs } from "@/lib/blog";
import {
  CATEGORIES,
  AUTHOR_KEYS,
  type Category,
  type AuthorKey,
} from "@/lib/blog-shared";

export type BlogPostInput = {
  id?: string;
  slug: string;
  title: string;
  description: string;
  excerpt: string;
  body: string;
  category: Category;
  author_key: AuthorKey;
  tags: string[];
  featured: boolean;
  status: "draft" | "published";
  published_on: string; // YYYY-MM-DD
  updated_on: string | null; // YYYY-MM-DD or null
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validate(input: BlogPostInput) {
  if (!input.title.trim()) throw new Error("Title is required");
  if (!input.slug.trim()) throw new Error("Slug is required");
  if (!/^[a-z0-9-]+$/.test(input.slug)) {
    throw new Error("Slug may only contain lowercase letters, numbers, and hyphens");
  }
  if (!input.description.trim()) throw new Error("Description is required");
  if (!input.body.trim()) throw new Error("Body can't be empty");
  if (!(CATEGORIES as readonly string[]).includes(input.category)) {
    throw new Error("Unknown category");
  }
  if (!(AUTHOR_KEYS as string[]).includes(input.author_key)) {
    throw new Error("Unknown author");
  }
  if (!DATE_RE.test(input.published_on)) {
    throw new Error("Publish date must be a real date");
  }
  if (input.updated_on && !DATE_RE.test(input.updated_on)) {
    throw new Error("Updated date must be a real date");
  }
  if (input.status !== "draft" && input.status !== "published") {
    throw new Error("Unknown status");
  }
}

// Revalidate every surface that enumerates or renders a post, so a publish or
// edit is visible immediately without a redeploy. The blog list, the post
// page + its OG image, the two static feeds, and the sitemap all read from the
// merged source in lib/blog.ts.
function revalidateBlog(slug: string, previousSlug?: string) {
  revalidatePath("/blog");
  revalidatePath(`/blog/${slug}`);
  revalidatePath(`/blog/${slug}/opengraph-image`);
  if (previousSlug && previousSlug !== slug) {
    revalidatePath(`/blog/${previousSlug}`);
    revalidatePath(`/blog/${previousSlug}/opengraph-image`);
  }
  revalidatePath("/blog/rss.xml");
  revalidatePath("/llms.txt");
  revalidatePath("/sitemap.xml");
  revalidatePath("/admin/blog");
}

export async function saveBlogPost(
  input: BlogPostInput,
): Promise<{ id: string; slug: string }> {
  const { userId } = await assertAdmin();
  validate(input);

  const slug = input.slug.trim();
  const admin = createAdminClient();

  // A DB post must never silently shadow a committed file post.
  if (listFileSlugs().includes(slug)) {
    throw new Error(
      `The slug "${slug}" belongs to a built-in (file) post. Pick a different slug.`,
    );
  }

  // Slug must be unique among DB posts (excluding this row on edit).
  const { data: clash } = await admin
    .from("blog_posts")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (clash && clash.id !== input.id) {
    throw new Error(`Another post already uses the slug "${slug}".`);
  }

  const payload = {
    slug,
    title: input.title.trim(),
    description: input.description.trim(),
    excerpt: input.excerpt.trim(),
    body: input.body,
    category: input.category,
    author_key: input.author_key,
    tags: input.tags.map((t) => t.trim()).filter(Boolean),
    featured: input.featured,
    status: input.status,
    published_on: input.published_on,
    updated_on: input.updated_on || null,
  };

  let id = input.id;
  let previousSlug: string | undefined;
  if (id) {
    const { data: existing } = await admin
      .from("blog_posts")
      .select("slug")
      .eq("id", id)
      .maybeSingle();
    previousSlug = existing?.slug;
    const { error } = await admin.from("blog_posts").update(payload).eq("id", id);
    if (error) throw new Error(error.message);
  } else {
    const { data: created, error } = await admin
      .from("blog_posts")
      .insert({ ...payload, created_by: userId })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    id = created!.id;
  }

  await logAudit({
    action: input.id ? "blog_post.updated" : "blog_post.created",
    targetType: "blog_post",
    targetId: id ?? null,
    payload: { slug, title: payload.title, status: payload.status },
  });

  revalidateBlog(slug, previousSlug);
  return { id: id!, slug };
}

export async function deleteBlogPost(id: string) {
  await assertAdmin();
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("blog_posts")
    .select("slug, title")
    .eq("id", id)
    .maybeSingle();
  const { error } = await admin.from("blog_posts").delete().eq("id", id);
  if (error) throw new Error(error.message);
  await logAudit({
    action: "blog_post.deleted",
    targetType: "blog_post",
    targetId: id,
    payload: { slug: existing?.slug ?? null, title: existing?.title ?? null },
  });
  if (existing?.slug) revalidateBlog(existing.slug);
  else revalidatePath("/admin/blog");
}

// Live preview: render markdown through the exact same pipeline the public
// post uses, so what the admin sees is what ships. Debounced on the client.
export async function renderBlogPreview(body: string): Promise<string> {
  await assertAdmin();
  return renderMarkdown(body || "");
}
