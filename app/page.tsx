import dynamic from "next/dynamic";
import Navbar from "@/components/navbar";
import Hero from "@/components/hero";
import Marquee from "@/components/marquee";
import Problem from "@/components/problem";
import Curriculum from "@/components/curriculum";
import Stats from "@/components/stats";
import Comparison from "@/components/comparison";
import FAQ from "@/components/faq";
import CTA from "@/components/cta";
import Footer from "@/components/footer";

// Scroll-preview is the only piece left that pulls framer-motion's
// scroll-linked APIs + a wide lucide icon set. It's below the fold, so we
// defer its JS until the user is past the hero. Reserve roughly the same
// height it occupies to avoid layout shift while it streams in.
const ScrollPreview = dynamic(() => import("@/components/scroll-preview"), {
  loading: () => <div aria-hidden className="h-[60rem] md:h-[80rem]" />,
});

export default function Home() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-black">
      <Navbar />
      <Hero />
      <Marquee />
      <Problem />
      <ScrollPreview />
      <Curriculum />
      <Stats />
      <Comparison />
      <FAQ />
      <CTA />
      <Footer />
    </main>
  );
}
