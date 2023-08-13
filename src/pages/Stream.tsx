import {
  Group,
  Text,
  Container,
  Stack,
  Flex,
  createStyles,
  Title,
  TextInput,
  Anchor,
} from '@mantine/core'
import { Header } from '@/components/Header'
import Markdown from 'markdown-to-jsx'
import MiniSearch from 'minisearch'
import { signal } from '@preact/signals'
import { friendlyDate, getJsonl } from '@/utils'
import { useTitle } from '@/hooks/useTitle'

const search = signal('')

const streamItems = await getJsonl('/stream.jsonl')
const miniSearch = new MiniSearch({
  fields: ['text'], // fields to index for full-text search
  storeFields: ['date', 'text'], // fields to return with search results
  searchOptions: {
    fuzzy: 0.1,
    prefix: true,
  },
})
miniSearch.addAll(streamItems)

const heading = { fontSize: '1.2em', marginBottom: 0 }
const margin = '0.3em'
const marginY = { marginTop: margin, marginBottom: margin }
const useStyles = createStyles((theme) => ({
  group: {},
  item: {
    color: theme.black,
    fontFamily: theme.headings.fontFamily,
    lineHeight: '1.2em',
    flexWrap: 'nowrap',
    fontSize: '0.85em',
    '& :first-of-type': {
      marginTop: 0,
    },
    '& p': marginY,
    '& ul': { ...marginY, marginLeft: '0em', paddingLeft: '1em' },
    '& blockquote': {
      marginTop: '0.8em',
      marginBottom: '0.8em',
      marginLeft: 0,
      paddingLeft: '1em',
      borderLeft: `0.25em solid ${theme.colors.gray[3]}`,
    },
    '& h1': heading,
    '& h2': heading,
    '& h3': heading,
    '& h4': heading,
    '& h5': heading,
    '& h6': heading,
    '& code': {
      fontFamily: theme.fontFamilyMonospace,
      background: theme.colors.gray[1],
      borderRadius: theme.radius.sm,
      paddingLeft: '0.2em',
      paddingRight: '0.2em',
      fontSize: '0.8em',
    },
    '& pre': {
      background: theme.colors.gray[1],
      padding: theme.spacing.sm,
      borderRadius: theme.radius.sm,
    },
  },
  date: {
    fontFamily: theme.fontFamilyMonospace,
    fontSize: '0.8em',
    marginRight: '0.2em',
    whiteSpace: 'nowrap',
  },
  search: {
    '& input': {
      ':focus': {
        border: `1px solid ${theme.colors.gray[4]}`,
      },
      fontFamily: theme.headings.fontFamily,
      fontWeight: 500,
    },
  },
}))
const markdownOptions = {
  overrides: {
    a: Anchor,
  },
}

function StreamItem({ date, markdown }) {
  const { classes } = useStyles()
  return (
    <Group className={classes.item} align="start">
      <Text color="dimmed" className={classes.date}>
        {friendlyDate(date, 'dd/MMM/yyyy')}
      </Text>
      <Flex>
        <Markdown options={markdownOptions}>{markdown}</Markdown>
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
      size="md"
      variant="filled"
      placeholder="Search..."
      className={classes.search}
    />
  )
}

export default function Stream() {
  useTitle('Stream')
  const { classes } = useStyles()
  const results = !search.value
    ? streamItems
    : miniSearch.search(search.value).sort((a, b) => (a.date > b.date ? 1 : -1))

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
