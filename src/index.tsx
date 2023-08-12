import 'preact/debug'
import { render } from 'preact'
import Router, { RouterProps } from 'preact-router'
import { Home } from '@/pages/Home'
import { Posts } from '@/pages/Posts'
import Post from '@/pages/Post'
import Stream from '@/pages/Stream'
import { NotFound } from '@/pages/404'
import { MantineProvider } from '@mantine/styles'
import { Box } from '@mantine/core'
import { theme } from '@/theme'

const MY_FOLDER = '/orionreed.github.io'
class SubfolderRouter extends Router {
  render(props: RouterProps, state: any) {
    if (state.url.indexOf(MY_FOLDER) === 0) {
      state = {
        ...state,
        url: state.url.substr(MY_FOLDER.length),
      }
    }
    return super.render(props, state)
  }
}

export function App() {
  return (
    <MantineProvider withGlobalStyles withNormalizeCSS theme={theme}>
      <Box mb="xl">
        <SubfolderRouter>
          <Home path="/" />
          <Posts path="/posts" />
          <Post path="/posts/:title" />
          <Stream path="/stream" />
          <NotFound default />
        </SubfolderRouter>
      </Box>
    </MantineProvider>
  )
}

render(<App />, document.getElementById('app'))
