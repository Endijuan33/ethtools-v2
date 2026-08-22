"use client"

/**
 * Developer tools panel.
 *
 * A thin container over three independent tools. It owns only which tool is
 * visible; each tool manages its own state, so they compose without coupling.
 */

import { useState } from "react"
import { ArrowLeftRight, FileCode2, Globe } from "lucide-react"
import Card, { CardDescription, CardHeader, CardTitle } from "./ui/Card"
import Tabs, { TabPanel } from "./ui/Tabs"
import UnitConverter from "./UnitConverter"
import EnsLookup from "./EnsLookup"
import CalldataDecoder from "./CalldataDecoder"

const TOOLS = [
  { id: "units", label: "Units", icon: ArrowLeftRight },
  { id: "ens", label: "ENS", icon: Globe },
  { id: "calldata", label: "Calldata", icon: FileCode2 },
] as const

type ToolId = (typeof TOOLS)[number]["id"]

export default function DevToolsCard() {
  const [active, setActive] = useState<ToolId>("units")

  return (
    <Card className="w-full max-w-lg">
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>Developer tools</CardTitle>
          <CardDescription>
            Everything runs in your browser. Only ENS lookups make a network request.
          </CardDescription>
        </div>
      </CardHeader>

      <Tabs
        items={TOOLS}
        value={active}
        onChange={setActive}
        label="Select a tool"
        layoutGroupId="devtools"
        className="mb-5"
      />

      <TabPanel id={active}>
        {active === "units" && <UnitConverter />}
        {active === "ens" && <EnsLookup />}
        {active === "calldata" && <CalldataDecoder />}
      </TabPanel>
    </Card>
  )
}
