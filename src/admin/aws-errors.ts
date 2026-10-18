/**
 * Plain words for AWS refusals, shared by the People actions and the invite-expiry sweep (whose
 * Lambda bundle can't pull in the People module's Next.js dependencies).
 */

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : 'Error';
}

/** Says why AWS refused, in words an admin can act on. Never a stack trace. */
export function describeAwsError(error: unknown): string {
  // An error auth-kit raised with words already written for the screen (it names items by noun and name).
  const userMessage = typeof error === 'object' && error !== null ? (error as { userMessage?: unknown }).userMessage : undefined;
  if (typeof userMessage === 'string' && userMessage !== '') return userMessage;
  const name = errorName(error);
  switch (name) {
    case 'TooManyRequestsException':
    case 'ThrottlingException':
      return 'Cognito is busy: its request quota is shared by every app in this AWS account. Try again in a few seconds.';
    case 'UserNotFoundException':
      return 'That person no longer exists in Cognito.';
    case 'UsernameExistsException':
      return 'That address already has an account.';
    case 'AccessDeniedException':
    case 'AccessDenied':
      return "The server's AWS role isn't allowed to make this call (check its IAM policy).";
    case 'NotAuthorizedException':
      return "Cognito refused the call: the server's role isn't allowed, or the account's state doesn't allow it.";
    case 'UnsupportedUserStateException':
      return "Cognito says this account's state doesn't allow that.";
    case 'LimitExceededException':
      return 'Cognito refused the call: a limit was reached (a person can be in at most 100 groups).';
    case 'ResourceNotFoundException':
      return 'Cognito couldn’t find the user pool or group (check the pool ID and that the group exists).';
    case 'MessageRejected':
    case 'MailFromDomainNotVerifiedException':
    case 'AccountSuspendedException':
    case 'SendingPausedException':
      return `SES refused the email (${name}).`;
    default:
      return `AWS couldn't complete the call (${name}).`;
  }
}
