/** AWS error messages can quote an address (SES names an unverified recipient): job logs never do. */
export function redactAddresses(text: string): string {
  return text.replace(/[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+/g, '[address]');
}
