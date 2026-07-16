import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { listFilePostsMeta } from "@/lib/blog";
import { AUTHORS, formatPostDate, type AuthorKey } from "@/lib/blog-shared";
import { Card } from "@/components/ui/card";
import { Plus, ExternalLink, Star } from "lucide-react";

export const metadata = { title: "Blog · Admin" };

type Row = {
  key: string;
  href: string | null; // edit link for DB posts; null for file posts
  slug: string;
  title: string;
  category: string;
  author: string;
  date: string;
  status: "published" | "draft";
  featured: boolean;
  source: "db" | "file";
};

export default async function AdminBlogPage() {
  const admin = createAdminClient();
  const { data: dbPosts } = await admin
    .from("blog_posts")
    .select("id, slug, title, category, author_key, status, published_on, featured")
    .order("published_on", { ascending: false });

  const dbRows: Row[] = (dbPosts ?? []).map((p: any) => ({
    key: `db-${p.id}`,
    href: `/admin/blog/${p.id}`,
    slug: p.slug,
    title: p.title,
    category: p.category,
    author: AUTHORS[p.author_key as AuthorKey]?.name ?? p.author_key,
    date: p.published_on,
    status: p.status,
    featured: p.featured,
    source: "db",
  }));

  const fileRows: Row[] = listFilePostsMeta().map((m) => ({
    key: `file-${m.slug}`,
    href: null,
    slug: m.slug,
    title: m.title,
    category: m.category,
    author: m.author.name,
    date: m.date,
    status: "published",
    featured: m.featured,
    source: "file",
  }));

  const rows = [...dbRows, ...fileRows].sort((a, b) =>
    a.date < b.date ? 1 : -1,
  );

  const dbCount = dbRows.length;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
            Blog
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-soft">
            Write and publish posts to the public blog. New posts are authored
            here and go live instantly. Built-in posts ship with the code and
            are edited in the repo.
          </p>
        </div>
        <Link
          href="/admin/blog/new"
          className="inline-flex h-10 items-center gap-2 rounded-lg bg-phosphor-fill px-4 text-sm font-semibold text-on-phosphor shadow-cta hover:bg-phosphor-fill-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
        >
          <Plus className="h-4 w-4" /> New post
        </Link>
      </div>

      <div className="mt-4 flex flex-wrap gap-4 text-xs text-ink-faint">
        <span>{rows.length} total</span>
        <span>{dbCount} authored here</span>
        <span>{fileRows.length} built-in</span>
      </div>

      <Card className="mt-4 !p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-ink-faint">
              <th className="px-5 py-3">Title</th>
              <th className="px-5 py-3">Status</th>
              <th className="px-5 py-3">Category</th>
              <th className="px-5 py-3">Author</th>
              <th className="px-5 py-3">Date</th>
              <th className="px-5 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.key}
                className="border-b border-line last:border-0 hover:bg-wash"
              >
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2 text-ink">
                    {r.featured && (
                      <Star className="h-3.5 w-3.5 shrink-0 fill-phosphor text-phosphor" />
                    )}
                    <span className="line-clamp-1">{r.title}</span>
                  </div>
                  <span className="font-mono text-[11px] text-ink-faint">
                    /blog/{r.slug}
                  </span>
                </td>
                <td className="px-5 py-3">
                  {r.status === "published" ? (
                    <span className="inline-flex items-center rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-500">
                      Published
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-500">
                      Draft
                    </span>
                  )}
                </td>
                <td className="px-5 py-3 text-ink-soft">{r.category}</td>
                <td className="px-5 py-3 text-ink-soft">{r.author}</td>
                <td className="px-5 py-3 text-ink-faint">
                  {formatPostDate(r.date)}
                </td>
                <td className="px-5 py-3 text-right">
                  {r.href ? (
                    <Link
                      href={r.href}
                      className="text-xs text-phosphor-ink hover:underline"
                    >
                      Edit →
                    </Link>
                  ) : (
                    <span className="inline-flex items-center gap-2">
                      <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-faint">
                        Built-in
                      </span>
                      <Link
                        href={`/blog/${r.slug}`}
                        target="_blank"
                        className="text-ink-faint hover:text-ink"
                        aria-label="View live"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Link>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
