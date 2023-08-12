import {
  Group,
  Text,
  useMantineTheme,
  Container,
  Stack,
  Flex,
  createStyles,
  Divider,
} from '@mantine/core'
import { format } from 'date-fns'
import { useEffect, useState } from 'preact/hooks'
import { Header } from '@/components/Header'
import Markdown from 'markdown-to-jsx'

const margin = '0.3em'

const useStyles = createStyles((theme) => ({
  group: {
    color: theme.black,
    lineHeight: '1.4em',
    fontFamily: theme.headings.fontFamily,
  },
  item: {
    flexWrap: 'nowrap',
    '& :first-child': {
      marginTop: 0,
    },
    '& p': {
      marginTop: margin,
      marginBottom: margin,
    },
    '& pre': {
      marginTop: margin,
      marginBottom: margin,
    },
    '& ul': {
      marginTop: margin,
      marginBottom: margin,
      paddingLeft: '1.4em',
    },

    '& blockquote': {
      marginTop: '0.8em',
      marginBottom: '0.8em',
      marginLeft: 0,
      paddingLeft: '1em',
      borderLeft: `0.25em solid ${theme.colors.gray[3]}`,
    },
  },
  date: {
    fontFamily: theme.headings.fontFamily,

    marginRight: '0.2em',
    whiteSpace: 'nowrap',
  },
}))

function friendlyDate(dateString: string): string {
  const inputDate = new Date(dateString)
  return format(inputDate, 'do MMM yyyy')
}

async function getStream() {
  const response = await fetch('stream.jsonl')
  return await (await response.text()).split('\n').map((post) => {
    return JSON.parse(post)
  })
}

function StreamItem({ date, markdown }) {
  const { classes } = useStyles()
  const black = useMantineTheme().black
  return (
    <Group className={classes.item} align="start">
      <Text color="dimmed" className={classes.date}>
        {friendlyDate(date)}
      </Text>
      <Flex>
        <Markdown>{markdown}</Markdown>
      </Flex>
    </Group>
  )
}

export default function Stream() {
  const { classes } = useStyles()
  const [stream, setPost] = useState<Array<object>>(null)
  useEffect(() => {
    getStream().then(setPost)
  }, [])

  if (!stream) {
    return <Text>Loading stream...</Text>
  } else {
    return (
      <>
        <Header />
        <Container size="40em" className={classes.group}>
          <Text>
            This <b>stream</b> is a place for me to think out loud and to share
            as I learn. It's not a place for well-formed ideas or for things I'm
            sure about. It's a place to explore, to be wrong, and to trust the
            reader (and myself) that this is okay.
          </Text>
          <Divider my="lg" />
          <Stack>
            {stream.map((s) => {
              return <StreamItem markdown={s.markdown} date={s.date} />
            })}
          </Stack>
        </Container>
      </>
    )
  }
}
