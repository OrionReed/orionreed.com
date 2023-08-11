import { Box, createStyles, Container, Group, Anchor } from '@mantine/core'
const useStyles = createStyles((theme) => ({
  home: {
    color: theme.black,
    fontFamily: theme.headings.fontFamily,
    fontSize: '1.2em',
    fontWeight: 800,
  },
  link: {
    color: theme.black,
    fontFamily: theme.headings.fontFamily,
    fontSize: '1.2em',
    fontWeight: 400,
  },
}))
export function Header({ dark }: { dark?: boolean }) {
  const { classes } = useStyles()
  return (
    <Box bg={dark ? 'red' : ''} py="2rem">
      <Container size="40em">
        <Group align="end">
          <Anchor href="/" className={classes.home}>
            orion reed
          </Anchor>
          <Anchor href="/posts" className={classes.link}>
            posts
          </Anchor>
          <Anchor href="/stream" className={classes.link}>
            stream
          </Anchor>
        </Group>
      </Container>
    </Box>
  )
}
