import {
  Box,
  Container,
  Text,
  TypographyStylesProvider,
  createStyles,
  Group,
} from '@mantine/core'
import Markdown from 'markdown-to-jsx'
import matter from 'gray-matter'
import { readingTime } from 'reading-time-estimator'
import { Header } from '@/components/Header'
import { useRoute } from 'preact-iso'
import { useState, useEffect } from 'preact/hooks'
import { friendlyDate } from '@/utils'

const useStyles = createStyles((theme) => ({
  title: {
    color: theme.black,
    fontSize: '2.5em',
    fontWeight: 400,
  },
  subtitle: {
    color: theme.black,
    fontSize: '2em',
    fontWeight: 400,
  },
  info: {
    color: theme.black,
    opacity: 0.8,
    fontWeight: 500,
  },
}))

async function getPost(name: string) {
  const response = await fetch(`${name}.md?raw`)
  return matter(await response.text())
}

export default function Post() {
  const current = useRoute().params.title
  const [post, setPost] = useState(null)
  const { classes } = useStyles()

  useEffect(() => {
    if (current) {
      getPost(current).then(setPost)
    }
  }, [current])

  if (!post) {
    return (
      <>
        <Header />
      </>
    )
  } else {
    const readTime = readingTime(post.content).text
    const date = friendlyDate(post.data.date)
    const location = post.data.location
    return (
      <>
        <Header dark />
        <Box mb="lg" bg="red" py="lg">
          <Container size="40em">
            <Text className={classes.title}>{post.data.title}</Text>
            <Text className={classes.subtitle}>{post.data.subtitle}</Text>
            <Group position="apart">
              <Text className={classes.info}>{date}</Text>
              <Text className={classes.info}>{location}</Text>
              <Text className={classes.info}>{readTime}</Text>
            </Group>
          </Container>
        </Box>
        <Container size="40em">
          <TypographyStylesProvider>
            <Markdown>{post.content}</Markdown>
          </TypographyStylesProvider>
        </Container>
      </>
    )
  }
}
