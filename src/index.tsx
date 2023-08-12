import { render } from 'preact'
import { LocationProvider, Router, Route } from 'preact-iso'
import { Home } from '@/pages/Home'
import { Posts } from '@/pages/Posts'
import Post from '@/pages/Post'
import Stream from '@/pages/Stream'
import { NotFound } from '@/pages/404'
import { MantineProvider } from '@mantine/styles'
import { Box } from '@mantine/core'
import { Header } from '@/components/Header'
import { style } from '@/style'

export function App() {
  return (
    <MantineProvider withGlobalStyles withNormalizeCSS theme={style}>
      <Box mb="xl">
        <LocationProvider>
          <Router>
            <Route path="/" component={Home} />
            <Route path="/posts" component={Posts} />
            <Route path="/posts/:title" component={Post} />
            <Route path="/stream" component={Stream} />
            <Route default component={NotFound} />
          </Router>
        </LocationProvider>
      </Box>
    </MantineProvider>
  )
}

render(<App />, document.getElementById('app'))
