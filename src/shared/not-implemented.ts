/** Thrown by phase-2 stubs. The message names the feature so a stray call is obvious. */
export class NotImplementedError extends Error {
  constructor(feature: string) {
    super(`auth-kit: ${feature} is not implemented yet (planned for phase 2; this is 0.1.0-alpha).`);
    this.name = 'NotImplementedError';
  }
}
