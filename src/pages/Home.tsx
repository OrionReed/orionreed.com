import { Header } from '@/components/Header'
import { Container, Text, Title, Anchor, Space } from '@mantine/core'

export function Home() {
  return (
    <>
      <Header />
      <Container size="40em">
        <Title order={3}>Hello! 👋</Title>
        <Text>
          My research investigates the intersection of computing, human-system
          interfaces, and emancipatory politics. I am interested in the
          potential of computing as a medium for thought, as a tool for
          collective action, and as a means of emancipation.
        </Text>
        <Text>
          My current focus is basic research into the nature of digital
          organisation, developing theoretical toolkits to improve shared
          infrastructure, and applying this research to the design of new
          systems and protocols which support the self-organisation of knowledge
          and computational artifacts.
        </Text>
        <Title order={3}>My work</Title>
        <Text>
          Alongside my independent work I am a researcher at{' '}
          <Anchor href="https://block.science/">Block Science</Anchor> building{' '}
          <i>knowledge organisation infrastructure</i> and at{' '}
          <Anchor href="https://economicspace.agency/">ECSA</Anchor> working on{' '}
          <i>computational media</i>. Previous work includes software and video
          game development, programming tools, and film production. I have
          expertise in knowledge representation, programming systems design, and
          human-computer interaction.
        </Text>
        <Title order={3}>Get in touch</Title>
        <Text>
          I am occasionally active on Twitter as <i>@OrionReedOne</i> and on
          Mastadon as <i>@orion@hci.social</i>. The best way to reach me is
          through Twitter or my email, <i>me@orionreed.com</i>
        </Text>
      </Container>
    </>
  )
}
