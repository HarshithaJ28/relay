import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto max-w-lg p-8">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <Link href="/" className="mt-2 inline-block text-sm text-accent underline">
        Back to the overview
      </Link>
    </main>
  );
}
