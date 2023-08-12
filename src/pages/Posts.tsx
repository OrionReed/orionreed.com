import { Header } from '@/components/Header'
import {
  Container,
  Group,
  Title,
  Text,
  Anchor,
  useMantineTheme,
  createStyles,
} from '@mantine/core'
import { friendlyDate, getJsonl } from '@/utils'

const posts = await getJsonl('/posts.jsonl')

type Post = {
  slug: string
  title: string
  date: string
}

const useStyles = createStyles((theme) => ({
  index: {
    fontFamily: theme.fontFamilyMonospace,
    fontSize: '0.85em',
    alignSelf: 'flex-end',
  },
  date: {
    fontFamily: theme.fontFamilyMonospace,
    fontSize: '0.85em',
    alignSelf: 'flex-end',
  },
}))

function PostListItem({ slug, title, date, index }) {
  const { classes } = useStyles()
  const black = useMantineTheme().black
  return (
    <Group>
      <Text color="dimmed" className={classes.index}>
        {`${index}`.padStart(3, '0')}
      </Text>
      <Anchor href={`posts/${slug}`} color={black}>
        {title}
      </Anchor>
      <Text color="dimmed" fs="italic" className={classes.date}>
        {friendlyDate(date, 'dd/MMM/yyyy')}
      </Text>
    </Group>
  )
}

function Frame({ children }) {
  return (
    <>
      <Header />
      <Container size="40em">
        <Title>2023</Title>
        {children}
      </Container>
    </>
  )
}

export function Posts() {
  return (
    <Frame>
      {posts.map((post, index, array) => {
        return (
          <PostListItem
            slug={post.slug}
            title={post.title}
            date={post.date}
            index={array.length - 1 - index}
          />
        )
      })}
    </Frame>
  )
}
