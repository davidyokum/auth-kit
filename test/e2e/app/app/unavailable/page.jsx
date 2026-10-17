import { AuthUnavailableError } from 'auth-kit/server';

// ?fail=1 throws auth-kit's "couldn't check" error, so the e2e test can see what error.jsx gets.
export default async function UnavailablePage({ searchParams }) {
  if ((await searchParams).fail === '1') throw new AuthUnavailableError();
  return <main>Checked</main>;
}
