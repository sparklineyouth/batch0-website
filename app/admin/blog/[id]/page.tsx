import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { BlogEditor } from "../blog-editor";
import type { BlogPostInput } from "../actions";
import type { Category, AuthorKey } from "@/lib/blog-shared";

export const metadata = { title: "Edit post · Admin" };

export default async function EditBlogPostPage({
  params,
}: {
  params: { id: string };
}) {
  const admin = createAdminClient();
  const { data: post } = await admin
    .from("blog_posts")
    .select(
      "id, slug, title, description, excerpt, body, category, author_key, tags, featured, status, published_on, updated_on",
    )
    .eq("id", params.id)
    .maybeSingle();
  if (!post) notFound();

  const initial: BlogPostInput = {
    id: post.id,
    slug: post.slug,
    title: post.title,
    description: post.description ?? "",
    excerpt: post.excerpt ?? "",
    body: post.body ?? "",
    category: post.category as Category,
    author_key: post.author_key as AuthorKey,
    tags: Array.isArray(post.tags) ? post.tags.map(String) : [],
    featured: Boolean(post.featured),
    status: post.status === "published" ? "published" : "draft",
    published_on: post.published_on,
    updated_on: post.updated_on ?? null,
  };

  return (
    <div className="mx-auto max-w-6xl">
      <Link href="/admin/blog" className="text-sm text-ink-soft hover:text-ink">
        ← Blog
      </Link>
      <h1 className="mt-3 font-display text-3xl font-bold tracking-[-0.02em] text-ink">
        Edit post
      </h1>
      <Card className="mt-6">
        <BlogEditor initial={initial} />
      </Card>
    </div>
  );
}
