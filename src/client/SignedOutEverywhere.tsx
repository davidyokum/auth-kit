import { useMemo } from 'react';
import { type AuthTheme, type ThemeFamily, resolveTheme } from '../themes/index.js';
import { SIGNED_OUT } from './copy.js';
import { tagged, useDriver } from './driver.js';
import { hrefOr } from './href.js';
import { Actions, Card, Glyph, Heading, type HeadingLevel, type StyleProps, Text, slot } from './ui.js';

export interface SignedOutEverywhereProps extends StyleProps {
  siteName: string;
  theme?: AuthTheme | ThemeFamily;
  /** "Sign in again". Default `/sign-in`. A same-site path or an http(s) URL (anything else throws). */
  signInHref?: string;
  headingLevel?: HeadingLevel;
}

/** "You're signed out everywhere" (Card Studio v4): where My account's "Sign out everywhere" lands. */
export function SignedOutEverywhere(props: SignedOutEverywhereProps) {
  const theme = useMemo(() => resolveTheme(props.theme), [props.theme]);
  const c = { siteName: props.siteName };
  const signInHref = hrefOr('signInHref', props.signInHref, '/sign-in');
  const signIn = useDriver().act('sign-in-again');
  return (
    <Card name="signed-out" theme={theme} {...(props.className !== undefined && { className: props.className })} classNames={props.classNames}>
      <div {...slot(props.classNames, 'form')}>
        <Glyph classNames={props.classNames} />
        <Heading level={props.headingLevel ?? 1} classNames={props.classNames}>
          {SIGNED_OUT.heading}
        </Heading>
        <Text classNames={props.classNames}>{SIGNED_OUT.sub(c)}</Text>
        <Actions classNames={props.classNames}>
          <a href={signInHref} onClick={signIn} {...tagged(signIn)} {...slot(props.classNames, 'button')}>
            {SIGNED_OUT.signInAgain}
          </a>
        </Actions>
      </div>
    </Card>
  );
}
