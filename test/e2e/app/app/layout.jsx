import { EnvironmentRibbon, environmentMetadata, environmentRibbonModel } from 'auth-kit/ribbon';
import { connection } from 'next/server';

export function generateMetadata() {
  const model = environmentRibbonModel({
    environment: 'local',
    poolId: 'us-east-1_PlaceholderPool',
    poolIsSandbox: null,
  });
  return environmentMetadata(model, 'Fixture');
}

export default async function RootLayout({ children }) {
  await connection(); // rendered per request, so the CSP nonce reaches every script
  return (
    <html lang="en">
      <body>
        <EnvironmentRibbon environment="local" poolId="us-east-1_PlaceholderPool" poolIsSandbox={null} />
        {children}
      </body>
    </html>
  );
}
