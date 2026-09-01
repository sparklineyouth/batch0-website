import Navbar from "@/components/navbar";
import Footer from "@/components/footer";

// Static legal text over a static shell. The only thing that was ever dynamic
// here was the footer's contact email, and that now reads from a tagged cache.
// An hour keeps the copyright year honest across New Year without giving the
// page any per-request work.
export const revalidate = 3600;

export default function LegalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Note: this layout doesn't use the @tailwindcss/typography plugin
  // (not installed). The `legal-prose` class in globals.css applies the
  // body/heading rhythm we need without pulling in a 30kb dependency.
  return (
    // <main> wraps the legal copy only. Wrapping Navbar and Footer in it
    // suppressed their banner/contentinfo landmarks and put the skip-link
    // target above the nav. The classes move with the element, so the layout
    // is byte-identical to the <article> it replaces.
    <div className="min-h-screen bg-paper">
      <Navbar />
      <main
        id="main-content"
        tabIndex={-1}
        className="legal-prose mx-auto max-w-3xl px-6 pb-20 pt-16"
      >
        {children}
      </main>
      <Footer />
    </div>
  );
}
