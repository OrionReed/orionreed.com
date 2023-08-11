import {
  Box,
  Text,
  createStyles,
  Container,
  Group,
  Title,
  Anchor,
} from '@mantine/core'

const useStyles = createStyles((theme) => ({
  navlink: {
    color: theme.black,
    fontFamily: theme.headings.fontFamily,
    fontSize: '1.2em',
    fontWeight: 700,
  },
}))
export function Header() {
  const { classes } = useStyles()

  return (
    <Box bg="red" py="2rem" mb="1rem">
      <Container size="md">
        <Group position="apart">
          <Title>Orion Reed</Title>
          <Group>
            <Anchor className={classes.navlink}>Posts</Anchor>
            <Anchor className={classes.navlink}>Stream</Anchor>
            <Anchor className={classes.navlink}>Contact</Anchor>
          </Group>
        </Group>
      </Container>
    </Box>
  )
}
