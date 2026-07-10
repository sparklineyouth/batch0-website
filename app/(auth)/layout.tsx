import Link from "next/link";
import Image from "next/image";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  // `theme-light` flips the dark-authored form components (inputs,
  // buttons, helper text) to the light palette via the compat layer in
  // globals.css — the marketing surface and the auth funnel read as one
  // site without rewriting every form.
  return (
    <div className="theme-light min-h-screen bg-paper">
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
        <Link href="/" className="mb-8 flex items-center gap-2">
          <Image src="/logo.svg" alt="" width={24} height={24} />
          <span className="font-display text-[15px] font-bold tracking-tight text-ink">
            SparkLine Youth
          </span>
        </Link>
        <div className="w-full rounded-md border border-line bg-paper p-7">
          {children}
        </div>
      </div>
    </div>
  );
}
