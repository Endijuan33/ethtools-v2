"use client"

/**
 * Developer tools panel.
 *
 * A thin container over seven independent tools. It owns only which tool is
 * visible; each tool manages its own state, so they compose without coupling.
 * Because exactly one tool is mounted at a time, a private key entered into a
 * signing tool is destroyed the moment the user switches tabs.
 */

import { useState } from "react"
import {
  ArrowLeftRight,
  Braces,
  FileCode2,
  FileJson,
  Fuel,
  Globe,
  PenLine,
} from "lucide-react"
import Card, { CardDescription, CardHeader, CardTitle } from "./ui/Card"
import Tabs, { TabPanel } from "./ui/Tabs"
import UnitConverter from "./UnitConverter"
import EnsLookup from "./EnsLookup"
import CalldataDecoder from "./CalldataDecoder"
import GasTrackerCard from "./GasTrackerCard"
import AbiEncoderCard from "./AbiEncoderCard"
import MessageSignCard from "./MessageSignCard"
import TypedDataSignCard from "./TypedDataSignCard"

const TOOLS = [
  { id: "units", label: "Units", icon: ArrowLeftRight },
  { id: "ens", label: "ENS", icon: Globe },
  { id: "calldata", label: "Calldata", icon: FileCode2 },
  { id: "encode", label: "Encode", icon: Braces },
  { id: "sign", label: "Sign", icon: PenLine },
  { id: "typed", label: "Typed data", icon: FileJson },
  { id: "gas", label: "Gas", icon: Fuel },
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
            Everything runs in your browser. Only ENS and gas lookups make a network request, and
            signing never does.
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
        {active === "encode" && <AbiEncoderCard />}
        {active === "sign" && <MessageSignCard />}
        {active === "typed" && <TypedDataSignCard />}
        {active === "gas" && <GasTrackerCard />}
      </TabPanel>
    </Card>
  )
}
