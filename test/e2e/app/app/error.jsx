'use client';
import { isAuthUnavailableError } from 'auth-kit/client';

export default function ErrorPage({ error }) {
  const unavailable = isAuthUnavailableError(error);
  return (
    <main>
      <h1>{unavailable ? 'Can’t check your sign-in right now' : 'This page couldn’t load'}</h1>
      {error.digest ? <p data-reference={error.digest}>Reference: {error.digest}</p> : null}
    </main>
  );
}
