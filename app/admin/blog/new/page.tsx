import Link from "next/link";
import { Card } from "@/components/ui/card";
import { BlogEditor } from "../blog-editor";
import type { BlogPostInput } from "../actions";

export const metadata = { title: "New post · Admin" };

export default function NewBlogPostPage() {
  const today = new Date().toISOString().slice(0, 10);

  const initial: BlogPostInput = {
    slug: "",
    title: "",
    description: "",
    excerpt: "",
    body: "",
    category: "Playbook",
    author_key: "team",
    tags: [],
    featured: false,
    status: "draft",
    published_on: today,
    updated_on: null,
  };

  return (
    <div className="mx-auto max-w-6xl">
      <Link href="/admin/blog" className="text-sm text-ink-soft hover:text-ink">
        ← Blog
      </Link>
      <h1 className="mt-3 font-display text-3xl font-bold tracking-[-0.02em] text-ink">
        New post
      </h1>
      <Card className="mt-6">
        <BlogEditor initial={initial} />
      </Card>
    </div>
  );
}
