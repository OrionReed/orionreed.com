import 'preact/debug'
import { render } from 'preact'
import Router from 'preact-router'
import { Home } from '@/pages/Home'
import { Posts } from '@/pages/Posts'
import Post from '@/pages/Post'
import Stream from '@/pages/Stream'
import { NotFound } from '@/pages/404'
import { MantineProvider } from '@mantine/styles'
import { Box } from '@mantine/core'
import { theme } from '@/theme'

export function App() {
  return (
    <MantineProvider withGlobalStyles withNormalizeCSS theme={theme}>
      <Box mb="xl">
        <Router>
          <Home path="/" />
          <Posts path="/posts(/?)" />
          <Post path="/posts/:title(/?)" />
          <Stream path="/stream(/?)" />
          <NotFound default />
        </Router>
      </Box>
    </MantineProvider>
  )
}

render(<App />, document.getElementById('app'))
