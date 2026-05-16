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
import { getSiteConfig } from "@/lib/site-config";
import { getProfile, roleHome } from "@/lib/auth";

// Scroll-preview is the only piece left that pulls framer-motion's
// scroll-linked APIs + a wide lucide icon set. It's below the fold, so we
// defer its JS until the user is past the hero. Reserve roughly the same
// height it occupies to avoid layout shift while it streams in.
const ScrollPreview = dynamic(() => import("@/components/scroll-preview"), {
  loading: () => <div aria-hidden className="h-[42rem] md:h-[80rem]" />,
});

export default async function Home() {
  const [config, profile] = await Promise.all([
    getSiteConfig(),
    getProfile(),
  ]);
  const authedHome = profile ? roleHome(profile.role) : null;
  return (
    <main className="relative min-h-screen overflow-hidden bg-black">
      <Navbar authedHome={authedHome} />
      <Hero config={config} authedHome={authedHome} />
      <Marquee />
      <Problem />
      <ScrollPreview config={config} />
      <Curriculum />
      <Stats config={config} />
      <Comparison config={config} />
      <FAQ config={config} />
      <CTA config={config} />
      <Footer config={config} />
    </main>
  );
}
