// Fixture B — prop drilling (multi-hop downstream).
// Place the cursor on `user` in <Layout user={user} /> inside App.
//
// Expect: downstream chain App → Layout → Sidebar → Avatar, with the final
// hop showing name={user.name}.
function useUser() {
  return { name: 'Ada Lovelace' };
}

export function App() {
  const user = useUser();
  return <Layout user={user} />;
}

function Layout({ user }: { user: { name: string } }) {
  return <Sidebar user={user} />;
}

function Sidebar({ user }: { user: { name: string } }) {
  return <Avatar name={user.name} />;
}

function Avatar({ name }: { name: string }) {
  return <img alt={name} />;
}
