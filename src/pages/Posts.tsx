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
import { format } from 'date-fns'
import { useEffect, useState } from 'preact/hooks'

function friendlyDate(dateString: string): string {
  const inputDate = new Date(dateString)
  return format(inputDate, 'do MMM yyyy')
}

async function getPosts() {
  const response = await fetch('posts.jsonl')
  return await (await response.text()).split('\n').map((post) => {
    return JSON.parse(post)
  })
}

const useStyles = createStyles((theme) => ({
  index: {
    fontFamily: 'monospace',
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
      <Text color="dimmed" fs="italic">
        {friendlyDate(date)}
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

type Post = {
  slug: string
  title: string
  date: string
}

export function Posts() {
  const [posts, setPost] = useState<Array<Post>>(null)
  useEffect(() => {
    getPosts().then(setPost)
  }, [])

  if (!posts) {
    return (
      <Frame>
        <Text>Loading posts...</Text>
      </Frame>
    )
  } else {
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
}
