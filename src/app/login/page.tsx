export default async function LoginPage({ searchParams }: { searchParams: Promise<{ invalid?: string }> }) {
  const { invalid } = await searchParams;

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6">
      <div className="border-b-2 border-ink pb-[18px]">
        <p className="display text-[12px] tracking-[0.26em] text-kelly">Hall of Blamers</p>
        <h1 className="display mt-1.5 text-page-title tracking-normal text-kelly-deep">Sign In</h1>
      </div>

      {invalid ? (
        // Deliberately not the `live` (red) token here — that's reserved for
        // live-game indicators, not form/link errors. Plain ink-on-sheet
        // keeps the "gold/live are scarce" discipline consistent.
        <div className="border border-line-sheet bg-sheet-raised px-4 py-3 text-sm text-ink">
          That invite link isn&apos;t valid — ask the commissioner for a fresh one.
        </div>
      ) : null}

      <p className="text-sm text-muted">
        There&apos;s no password here. Every league member gets a personal invite link from the
        commissioner — open it once on any device and you&apos;re signed in for the season.
      </p>
      <p className="text-sm text-muted">Lost your link, or need one for the first time? Ask Richey.</p>
    </div>
  );
}
