/**
 * `auth-kit/amplify`: the Gen 2 backend preset.
 *
 * ```ts
 * // amplify/auth/resource.ts
 * import { defineAuth } from '@aws-amplify/backend';
 * import { standardAuthProps, type AuthStandardOptions } from 'auth-kit/amplify';
 *
 * export const authOptions = {
 *   project: 'reports-portal',
 *   owner: 'reports-team',
 *   tier: 2,
 *   email: { fromAddress: 'noreply@example.org', fromName: 'Example Reports' },
 *   passkeys: { relyingPartyId: 'reports.example.org' }, // once the final domain is live
 * } satisfies AuthStandardOptions;
 *
 * export const auth = defineAuth(standardAuthProps(authOptions));
 *
 * // amplify/backend.ts
 * const backend = defineBackend({ auth });
 * applyAuthStandard(backend.auth, authOptions);
 * ```
 */
export { standardAuthProps, type DefineAuthProps, type StandardAuthExtras } from './props.js';
export { applyAuthStandard, formatSender, type AppliedAuthStandard, type AppliedWaf, type AuthResourceLike } from './apply.js';
export {
  normalizeOptions,
  AuthStandardConfigError,
  type AuthStandardOptions,
  type AuthEmailOptions,
  type PasskeyOptions,
  type WafOptions,
  type WafRuleSettings,
  type WafRuleMode,
  type NormalizedWafOptions,
  type SelfSignUpOptions,
  type NormalizedAuthStandardOptions,
} from './options.js';
export {
  createAuthWebAcl,
  createSharedAuthWebAcl,
  associateAuthWebAcl,
  COGNITO_OPERATION_HEADERS,
  SIGN_IN_OPERATIONS,
  type AuthWebAcl,
  type AuthWebAclProps,
  type SharedAuthWebAclProps,
} from './waf.js';
export {
  STANDARD_GROUPS,
  STANDARD_CAPABILITIES,
  ADMIN_ROLE_RANK,
  SESSION_POLICY,
  PASSWORD_POLICY,
  WAF_POLICY,
  AMPLIFY_DEPLOYMENT_TYPE_CONTEXT_KEY,
  type AuthTier,
  type StandardGroup,
  type AmplifyDeploymentType,
} from '../shared/policy.js';
