import Navbar from "@/components/navbar";
import Footer from "@/components/footer";

export default function LegalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Note: this layout doesn't use the @tailwindcss/typography plugin
  // (not installed). The `legal-prose` class in globals.css applies the
  // body/heading rhythm we need without pulling in a 30kb dependency.
  return (
    <main className="min-h-screen bg-paper">
      <Navbar />
      <article className="legal-prose mx-auto max-w-3xl px-6 pb-20 pt-16">
        {children}
      </article>
      <Footer />
    </main>
  );
}
