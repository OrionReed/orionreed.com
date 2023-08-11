import { render } from 'preact'
import { LocationProvider, Router, Route } from 'preact-iso'
import { Home } from './pages/Home'
import { Posts } from './pages/Posts'
import { NotFound } from './pages/404'
import { MantineProvider } from '@mantine/styles'
import { Container } from '@mantine/core'
import { Header } from './components/Header'
import { style } from './style'
export function App() {
  return (
    <MantineProvider withGlobalStyles withNormalizeCSS theme={style}>
      <Header />
      <Container size="md">
        <LocationProvider>
          <Router>
            <Route path="/" component={Home} />
            <Route path="/posts" component={Posts} />
            <Route default component={NotFound} />
          </Router>
        </LocationProvider>
      </Container>
    </MantineProvider>
  )
}

render(<App />, document.getElementById('app'))
