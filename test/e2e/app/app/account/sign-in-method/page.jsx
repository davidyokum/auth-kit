import { pages } from '../../../lib/auth.js';

// "Choose how you'll sign in next time": the one page an account with only emailed codes may reach
// (the page guards send it here). A real site renders ChooseFirstCredential from auth-kit/client.
export default async function ChooseSignInMethodPage() {
  const user = await pages.requireUser({ allowFirstCredentialEnrollment: true });
  return <main>Choose how you’ll sign in next time, {user.sub}</main>;
}
