import { useLocalSearchParams } from "expo-router";
import { InstallSkillScreen } from "@/features/settings/SkillsScreen";

/** "Instalar skill", pushed over Skills; `url`: an agent's card, the link read to pick from; `agent`: that agent. */
export default function SettingsInstallSkillRoute() {
  const { url, agent } = useLocalSearchParams<{ url?: string; agent?: string }>();
  return <InstallSkillScreen initialUrl={url} forAgentId={agent} />;
}
