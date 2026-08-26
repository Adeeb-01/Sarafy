import { Text, TextInput, TextStyle } from 'react-native';

export const fonts = {
  regular: 'Cairo_400Regular', medium: 'Cairo_600SemiBold',
  bold: 'Cairo_700Bold', black: 'Cairo_900Black',
} as const;

export const typography = {
  display: { fontFamily: fonts.bold, fontSize: 28, lineHeight: 36 } satisfies TextStyle,
  titleLarge: { fontFamily: fonts.bold, fontSize: 22, lineHeight: 29 } satisfies TextStyle,
  title: { fontFamily: fonts.bold, fontSize: 17, lineHeight: 24 } satisfies TextStyle,
  subtitle: { fontFamily: fonts.medium, fontSize: 15, lineHeight: 22 } satisfies TextStyle,
  body: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 21 } satisfies TextStyle,
  bodyMedium: { fontFamily: fonts.medium, fontSize: 14, lineHeight: 21 } satisfies TextStyle,
  label: { fontFamily: fonts.medium, fontSize: 13, lineHeight: 19 } satisfies TextStyle,
  caption: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17 } satisfies TextStyle,
  numericLarge: { fontFamily: fonts.bold, fontSize: 24, lineHeight: 31, fontVariant: ['tabular-nums'] } satisfies TextStyle,
  numericMedium: { fontFamily: fonts.medium, fontSize: 18, lineHeight: 25, fontVariant: ['tabular-nums'] } satisfies TextStyle,
  numericTotal: { fontFamily: fonts.bold, fontSize: 22, lineHeight: 29, fontVariant: ['tabular-nums'] } satisfies TextStyle,
  numericEmphasis: { fontFamily: fonts.bold, fontSize: 16, lineHeight: 22, fontVariant: ['tabular-nums'] } satisfies TextStyle,
  numericCompact: { fontFamily: fonts.bold, fontSize: 15, lineHeight: 21, fontVariant: ['tabular-nums'] } satisfies TextStyle,
  numericSmall: { fontFamily: fonts.bold, fontSize: 14, lineHeight: 20, fontVariant: ['tabular-nums'] } satisfies TextStyle,
} as const;

type WithDefaults = {
  defaultProps?: { style?: unknown };
};

let configured = false;

export function configureDefaultTypography() {
  if (configured) return;
  configured = true;

  const text = Text as typeof Text & WithDefaults;
  const input = TextInput as typeof TextInput & WithDefaults;

  text.defaultProps = {
    ...text.defaultProps,
    style: [text.defaultProps?.style, { fontFamily: fonts.regular }],
  };
  input.defaultProps = {
    ...input.defaultProps,
    style: [input.defaultProps?.style, { fontFamily: fonts.regular }],
  };
}
