import Link from "next/link";
import Image from "next/image";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen bg-black">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-spark-radial opacity-60"
      />
      <div className="relative mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 py-12">
        <Link href="/" className="mb-8 flex items-center gap-2.5">
          <Image src="/logo.svg" alt="SparkLine" width={32} height={32} className="animate-spark-pulse" />
          <span className="text-lg font-semibold tracking-tight text-white">SparkLine</span>
        </Link>
        <div className="w-full rounded-2xl border border-white/10 bg-zinc-900/60 p-7 backdrop-blur">
          {children}
        </div>
      </div>
    </div>
  );
}
