import type {
  CognitoIdentityProviderClient} from '@aws-sdk/client-cognito-identity-provider';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminUpdateUserAttributesCommand,
  AdminUserGlobalSignOutCommand,
  type AttributeType,
  ListUsersCommand,
  ListUsersInGroupCommand,
  type UserType,
  VerifyUserAttributeCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { SIGN_UP_ORIGIN_VALUE } from '../shared/account-creation.js';
import { SIGN_UP_ORIGIN_ATTRIBUTE } from '../shared/account-creation.js';
import type { InviteMode } from './guardrails.js';
import type { QuotaLimiter } from './quota.js';

/** A person as Cognito's list APIs describe them. */
export interface CognitoPerson {
  username: string;
  sub: string;
  email: string;
  name?: string;
  emailVerified: boolean;
  enabled: boolean;
  status: string;
  createdAt: Date;
  /** When Cognito last changed the account (its attributes, status, or enabled state). */
  modifiedAt?: Date;
  /** `signup` for an account auth-kit's sign-up route made (read only on sign-up sites). */
  origin?: string;
}

function attr(attributes: AttributeType[] | undefined, name: string): string | undefined {
  return attributes?.find((a) => a.Name === name)?.Value;
}

/** Null when Cognito returns a user without a username or sub (it shouldn't). */
export function personFromUser(user: UserType | undefined): CognitoPerson | null {
  if (!user?.Username) return null;
  const attributes = user.Attributes;
  const sub = attr(attributes, 'sub');
  if (!sub) return null;
  const name = attr(attributes, 'name');
  return {
    username: user.Username,
    sub,
    email: attr(attributes, 'email') ?? '',
    ...(name !== undefined && { name }),
    emailVerified: attr(attributes, 'email_verified') === 'true',
    enabled: user.Enabled === true,
    status: user.UserStatus ?? 'UNKNOWN',
    createdAt: user.UserCreateDate instanceof Date ? user.UserCreateDate : new Date(user.UserCreateDate ?? 0),
    ...(user.UserLastModifiedDate !== undefined && { modifiedAt: user.UserLastModifiedDate instanceof Date ? user.UserLastModifiedDate : new Date(user.UserLastModifiedDate) }),
    ...(attr(attributes, SIGN_UP_ORIGIN_ATTRIBUTE) !== undefined && { origin: attr(attributes, SIGN_UP_ORIGIN_ATTRIBUTE) }),
  };
}

/** Values interpolated into a ListUsers filter. Validated by the caller; quotes are refused here too. */
function filterValue(value: string): string {
  if (/["\\]/.test(value)) throw new Error('auth-kit: a ListUsers filter value cannot contain quotes or backslashes.');
  return `"${value}"`;
}

const LIST_ATTRIBUTES = ['sub', 'email', 'email_verified', 'name'];

/**
 * The Admin* and List* calls the People page makes, each spent against its quota category. Reads
 * retry transient failures; writes retry only throttling (which guarantees the call didn't run).
 */
export interface CognitoAdminOptions {
  /** Also read the sign-up mark (`custom:authkit_origin`). Only on sign-up sites, whose pools have it. */
  signUpOrigin?: boolean;
}

export class CognitoAdmin {
  private readonly attributes: string[];

  constructor(
    readonly client: CognitoIdentityProviderClient,
    readonly userPoolId: string,
    private readonly limiter: QuotaLimiter,
    options: CognitoAdminOptions = {},
  ) {
    this.attributes = options.signUpOrigin ? [...LIST_ATTRIBUTES, SIGN_UP_ORIGIN_ATTRIBUTE] : LIST_ATTRIBUTES;
  }

  /** Everyone, 60 a page (ListUsers' maximum), stopping at `max`. */
  async listUsers(max: number): Promise<{ users: CognitoPerson[]; truncated: boolean }> {
    const users: CognitoPerson[] = [];
    let token: string | undefined;
    do {
      const page = await this.limiter.run(
        'UserList',
        () =>
          this.client.send(
            new ListUsersCommand({ UserPoolId: this.userPoolId, Limit: 60, AttributesToGet: this.attributes, PaginationToken: token }),
          ),
        { read: true },
      );
      const list = page.Users ?? [];
      for (let i = 0; i < list.length; i++) {
        const p = personFromUser(list[i]);
        if (p) users.push(p);
        if (users.length >= max) return { users, truncated: i < list.length - 1 || page.PaginationToken !== undefined };
      }
      token = page.PaginationToken;
    } while (token);
    return { users, truncated: false };
  }

  /**
   * The pool a page (60 people) at a time, optionally narrowed by a ListUsers filter, without holding
   * the whole pool in memory: a job that only needs a few of the people can page past any size.
   */
  async *userPages(filter?: string): AsyncGenerator<CognitoPerson[]> {
    let token: string | undefined;
    do {
      const page = await this.limiter.run(
        'UserList',
        () =>
          this.client.send(
            new ListUsersCommand({ UserPoolId: this.userPoolId, Limit: 60, AttributesToGet: this.attributes, PaginationToken: token, ...(filter !== undefined && { Filter: filter }) }),
          ),
        { read: true },
      );
      yield (page.Users ?? []).map(personFromUser).filter((p): p is CognitoPerson => p !== null);
      token = page.PaginationToken;
    } while (token);
  }

  /** AdminGetUser: the account as it is now (every attribute), or null when it's gone. */
  async getUser(username: string): Promise<CognitoPerson | null> {
    try {
      const out = await this.limiter.run('UserResourceRead', () => this.client.send(new AdminGetUserCommand({ UserPoolId: this.userPoolId, Username: username })), { read: true });
      return personFromUser({
        Username: out.Username,
        Attributes: out.UserAttributes,
        Enabled: out.Enabled,
        UserStatus: out.UserStatus,
        UserCreateDate: out.UserCreateDate,
        UserLastModifiedDate: out.UserLastModifiedDate,
      });
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'UserNotFoundException') return null;
      throw error;
    }
  }

  /** Every member of one group (ListUsersInGroup, 60 a page). */
  async listGroupMembers(group: string, max: number = Number.POSITIVE_INFINITY): Promise<CognitoPerson[]> {
    const out: CognitoPerson[] = [];
    let token: string | undefined;
    do {
      const page = await this.limiter.run(
        'UserList',
        () => this.client.send(new ListUsersInGroupCommand({ UserPoolId: this.userPoolId, GroupName: group, Limit: 60, NextToken: token })),
        { read: true },
      );
      for (const u of page.Users ?? []) {
        const p = personFromUser(u);
        if (p) out.push(p);
      }
      if (out.length >= max) break;
      token = page.NextToken;
    } while (token);
    return out;
  }

  private async findOne(filter: string): Promise<CognitoPerson | null> {
    const page = await this.limiter.run(
      'UserList',
      () => this.client.send(new ListUsersCommand({ UserPoolId: this.userPoolId, Filter: filter, Limit: 2, AttributesToGet: this.attributes })),
      { read: true },
    );
    return personFromUser(page.Users?.[0]);
  }

  /** ListUsers with `sub = "…"` (one UserList call; the sub is the stable ID the page holds). */
  findBySub(sub: string): Promise<CognitoPerson | null> {
    return this.findOne(`sub = ${filterValue(sub)}`);
  }

  findByEmail(email: string): Promise<CognitoPerson | null> {
    return this.findOne(`email = ${filterValue(email)}`);
  }

  /** AdminListGroupsForUser, every page. */
  async groupsOf(username: string): Promise<string[]> {
    const groups: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.limiter.run(
        'UserResourceRead',
        () => this.client.send(new AdminListGroupsForUserCommand({ UserPoolId: this.userPoolId, Username: username, Limit: 60, NextToken: token })),
        { read: true },
      );
      for (const g of page.Groups ?? []) if (g.GroupName) groups.push(g.GroupName);
      token = page.NextToken;
    } while (token);
    return groups;
  }

  /**
   * AdminCreateUser for an invite. Never sets a password or `email_verified`:
   * - `emailed-code`: no TemporaryPassword (a passwordless user, CONFIRMED at once) and
   *   MessageAction SUPPRESS (the app sends its own branded email).
   * - `temporary-password`: Cognito generates a one-time password and emails it with the pool's
   *   invitation template. The app never sees it.
   */
  async createInvitedUser(input: { email: string; name?: string; mode: InviteMode; origin?: typeof SIGN_UP_ORIGIN_VALUE }): Promise<CognitoPerson> {
    const attributes: AttributeType[] = [{ Name: 'email', Value: input.email }];
    if (input.name) attributes.push({ Name: 'name', Value: input.name });
    // Sign-up accounts are marked once, here (the attribute is immutable): the sweep, the preSignUp
    // trigger, and the code email all tell them from admin invites by it.
    if (input.origin) attributes.push({ Name: SIGN_UP_ORIGIN_ATTRIBUTE, Value: input.origin });
    const out = await this.limiter.run('UserCreation', () =>
      this.client.send(
        new AdminCreateUserCommand({
          UserPoolId: this.userPoolId,
          Username: input.email,
          UserAttributes: attributes,
          DesiredDeliveryMediums: ['EMAIL'],
          ...(input.mode === 'emailed-code' && { MessageAction: 'SUPPRESS' }),
        }),
      ),
    );
    const person = personFromUser(out.User);
    if (!person) throw new Error('auth-kit: AdminCreateUser returned no user.');
    return person;
  }

  /** AdminCreateUser with MessageAction RESEND: a new one-time password (temporary-password mode only). */
  async resendTemporaryPassword(username: string): Promise<void> {
    await this.limiter.run('UserCreation', () =>
      this.client.send(
        new AdminCreateUserCommand({ UserPoolId: this.userPoolId, Username: username, MessageAction: 'RESEND', DesiredDeliveryMediums: ['EMAIL'] }),
      ),
    );
  }

  async addToGroup(username: string, group: string): Promise<void> {
    await this.limiter.run('UserUpdate', () =>
      this.client.send(new AdminAddUserToGroupCommand({ UserPoolId: this.userPoolId, Username: username, GroupName: group })),
    );
  }

  async removeFromGroup(username: string, group: string): Promise<void> {
    await this.limiter.run('UserUpdate', () =>
      this.client.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: this.userPoolId, Username: username, GroupName: group })),
    );
  }

  async disable(username: string): Promise<void> {
    await this.limiter.run('UserUpdate', () => this.client.send(new AdminDisableUserCommand({ UserPoolId: this.userPoolId, Username: username })));
  }

  async enable(username: string): Promise<void> {
    await this.limiter.run('UserUpdate', () => this.client.send(new AdminEnableUserCommand({ UserPoolId: this.userPoolId, Username: username })));
  }

  async globalSignOut(username: string): Promise<void> {
    await this.limiter.run('UserUpdate', () =>
      this.client.send(new AdminUserGlobalSignOutCommand({ UserPoolId: this.userPoolId, Username: username })),
    );
  }

  /**
   * AdminUpdateUserAttributes with a new email address. With the pool's
   * `AttributesRequireVerificationBeforeUpdate`, the old address stays in effect and Cognito sends a
   * code to the new one; the change happens when the person enters it (`verifyEmailWithToken`).
   */
  async updateEmail(username: string, email: string): Promise<void> {
    await this.limiter.run('UserUpdate', () =>
      this.client.send(new AdminUpdateUserAttributesCommand({ UserPoolId: this.userPoolId, Username: username, UserAttributes: [{ Name: 'email', Value: email }] })),
    );
  }

  /** VerifyUserAttribute with the person's own access token: the code to their new address. */
  async verifyEmailWithToken(accessToken: string, code: string): Promise<void> {
    await this.client.send(new VerifyUserAttributeCommand({ AccessToken: accessToken, AttributeName: 'email', Code: code }));
  }

  async deleteUser(username: string): Promise<void> {
    await this.limiter.run('UserUpdate', () => this.client.send(new AdminDeleteUserCommand({ UserPoolId: this.userPoolId, Username: username })));
  }
}
