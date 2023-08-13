import {
  Box,
  Container,
  Text,
  TypographyStylesProvider,
  createStyles,
  Group,
} from '@mantine/core'
import Markdown from 'markdown-to-jsx'
import fm from 'front-matter'
import { readingTime } from 'reading-time-estimator'
import { Header } from '@/components/Header'
import { getCurrentUrl } from 'preact-router'
import { useState, useEffect } from 'preact/hooks'
import { friendlyDate } from '@/utils'
import { useTitle } from '@/hooks/useTitle'

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
  return fm(await response.text())
}

export default function Post() {
  const current = getCurrentUrl().split('/')[2]
  console.log(current)

  const [post, setPost] = useState(null)
  const { classes } = useStyles()

  useEffect(() => {
    if (current) {
      getPost(`/posts_md/${current}`).then(setPost)
    }
  }, [current])

  if (!post) {
    return (
      <>
        <Header />
      </>
    )
  } else {
    useTitle(post.attributes.title)
    const readTime = readingTime(post.body).text
    const date = friendlyDate(post.attributes.date)
    const location = post.attributes.location
    return (
      <>
        <Header dark />
        <Box mb="lg" bg="red" py="lg">
          <Container size="40em">
            <Text className={classes.title}>{post.attributes.title}</Text>
            <Text className={classes.subtitle}>{post.attributes.subtitle}</Text>
            <Group position="apart">
              <Text className={classes.info}>{date}</Text>
              <Text className={classes.info}>{location}</Text>
              <Text className={classes.info}>{readTime}</Text>
            </Group>
          </Container>
        </Box>
        <Container size="40em">
          <TypographyStylesProvider>
            <Markdown>{post.body}</Markdown>
          </TypographyStylesProvider>
        </Container>
      </>
    )
  }
}
