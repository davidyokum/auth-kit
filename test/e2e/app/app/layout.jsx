import { connection } from 'next/server';

export default async function RootLayout({ children }) {
  await connection(); // rendered per request, so the CSP nonce reaches every script
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
