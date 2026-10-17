/** A JSON Web Key Set, as Cognito publishes at `/.well-known/jwks.json`. */
export interface JwksLike {
  keys: readonly Record<string, unknown>[];
}
