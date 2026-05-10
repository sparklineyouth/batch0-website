import Navbar from "@/components/navbar";
import Footer from "@/components/footer";

export default function LegalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main className="relative min-h-screen overflow-hidden bg-black text-white">
      <Navbar />
      <article className="relative mx-auto max-w-3xl px-6 pt-32 pb-20 prose prose-invert prose-headings:tracking-tight">
        {children}
      </article>
      <Footer />
    </main>
  );
}
