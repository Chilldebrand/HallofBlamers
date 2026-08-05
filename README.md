This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

**After pulling new code, run `npm run db:migrate` before starting the dev server** if you
haven't already — see [Database migrations](#database-migrations) below. This step only happens
automatically in the production Docker deploy (Task 28); local `npm run dev` never applies
migrations for you.

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Database migrations

Hall of Blamers uses [Drizzle](https://orm.drizzle.team/)-managed SQLite migrations
(`src/server/db/migrations/`, applied via `src/server/db/migrate.ts`). **After pulling new code,
always run:**

```bash
npm run db:migrate
```

This is idempotent (drizzle's own journal tracks what's already applied, see
`src/server/db/__tests__/migrate.test.ts`) — running it when there's nothing new to apply is a
safe no-op, so it's fine to run it after every pull as a habit rather than only when you know a
migration shipped. Skipping it after a pull that *did* ship one will 500 any page that touches the
new table/column — this happened locally once (migration `0006` shipped but was never applied,
until it was run by hand). The production Docker deploy applies migrations automatically as part
of `./ops/deploy.sh` (see `docker-compose.yml`'s `migrate` service and `docs/RUNBOOK.md`); local
`npm run dev` does not, which is why this is a manual step here.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
