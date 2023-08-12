import {
  Group,
  Text,
  Container,
  Stack,
  Flex,
  createStyles,
  Title,
  TextInput,
} from '@mantine/core'
import { Header } from '@/components/Header'
import Markdown from 'markdown-to-jsx'
import MiniSearch from 'minisearch'
import { signal } from '@preact/signals'
import { friendlyDate, getJsonl } from '@/utils'

const search = signal('')

const margin = '0.3em'
const streamItems = await getJsonl('stream.jsonl')
const miniSearch = new MiniSearch({
  fields: ['text'], // fields to index for full-text search
  storeFields: ['date', 'text'], // fields to return with search results
  searchOptions: {
    fuzzy: 0.2,
    prefix: true,
  },
})
miniSearch.addAll(streamItems)

const useStyles = createStyles((theme) => ({
  group: {
    color: theme.black,
    lineHeight: '1.4em',
    fontFamily: theme.headings.fontFamily,
  },
  item: {
    flexWrap: 'nowrap',
    '& :first-of-type': {
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
  search: {
    fontFamily: theme.headings.fontFamily,
    // border: `1px solid red`,
    fontSize: '4em',
    '& :focus': {
      border: `1px solid ${theme.black}`,
    },
  },
}))

function StreamItem({ date, markdown }) {
  const { classes } = useStyles()
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

type StreamItem = {
  date: string
  markdown: string
}

function Search() {
  const { classes } = useStyles()
  return (
    <TextInput
      onInput={(event) => {
        search.value = event.target.value
      }}
      my="sm"
      className={classes.search}
      placeholder="Search"
    />
  )
}

export default function Stream() {
  const { classes } = useStyles()
  console.log(search.value)
  const results = !search.value ? streamItems : miniSearch.search(search.value)
  console.log(results)

  return (
    <>
      <Header />
      <Container size="40em" className={classes.group}>
        <Title order={2}>What is this?</Title>
        <Text>
          This <b>stream</b> is a place for me to think out loud and to share as
          I learn. It's not a place for well-formed ideas or for things I'm sure
          about. It's a place to explore, to be wrong, and to trust the reader
          (and myself) that this is okay.
        </Text>
        <Search />
        <Stack>
          {results.map((s) => {
            return <StreamItem markdown={s.text} date={s.date} />
          })}
        </Stack>
      </Container>
    </>
  )
}
