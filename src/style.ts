export const style = {
  fontFamily: 'Alegreya, serif',
  headings: {
    fontFamily: ['Alegreya Sans'],
    fontWeight: 700,
  },
  lineHeight: 1.5,
  fontSizes: {
    xs: '0.6rem',
    sm: '0.75rem',
    md: '1.2rem',
    lg: '1rem',
    xl: '1.2rem',
  },
  black: '#24292e',
  primaryColor: 'red',
  components: {
    Anchor: {
      styles: (theme, { variant }) => ({
        root: {
          color: theme.black,
          textDecoration: 'underline',
          textUnderlineOffset: '0.15rem',
          textDecorationThickness: '0.15rem',
          textDecorationColor: theme.colors.dark[1],
          '&:hover': {
            textDecorationThickness: '0.15rem',
            textDecorationColor: theme.black,
          },
        },
      }),
    },
    Text: {
      styles: (theme, { variant }) => ({
        root: {
          marginBottom: '0.6rem',
        },
      }),
    },
  },
}
