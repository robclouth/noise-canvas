import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger
} from "@/components/ui/menubar"
import { useEffect } from "react"

function App(): React.JSX.Element {
  const analysisParams = {
    bandsPerOctave: 96,
    fmin: 20.0
  }

  const runAnalysis = async (filePath: string): Promise<void> => {
    const spectrogram = await window.electron.ipcRenderer.invoke(
      "analyze-audio",
      filePath,
      analysisParams
    )

    // Log the structure of the spectrogram
    if (spectrogram && Array.isArray(spectrogram)) {
      console.log(`Spectrogram analysis complete for: ${filePath}`)
      console.log(`Number of channels: ${spectrogram.length}`)

      let totalCoefficients = 0

      spectrogram.forEach((channel, channelIndex) => {
        if (channel && Array.isArray(channel)) {
          console.log(`  Channel ${channelIndex + 1}:`)
          console.log(`    Number of bands: ${channel.length}`)

          // Log info about the first band as a sample
          if (channel.length > 0) {
            const firstBand = channel[0]
            if (firstBand instanceof Float32Array) {
              console.log(
                `    First band contains a Float32Array with ${
                  firstBand.length
                } elements (representing ${firstBand.length / 2} complex coefficients).`
              )
            } else {
              console.log(`    First band data type: ${typeof firstBand}`)
            }
          }
          // Sum coefficients for this channel
          totalCoefficients += channel.reduce((sum, band) => sum + band.length / 2, 0)
        } else {
          console.log(`  Channel ${channelIndex + 1} data is not an array.`)
        }
      })

      console.log(`Total number of complex coefficients: ${totalCoefficients}`)
    } else {
      console.log("Analysis did not return the expected structure:", spectrogram)
    }
  }

  const handleAnalyze = async (): Promise<void> => {
    const filePath = await window.electron.ipcRenderer.invoke("open-file-dialog")
    if (filePath) {
      runAnalysis(filePath)
    }
  }

  useEffect(() => {
    const testFilePath =
      "/Users/rob/Splice/sounds/packs/Fresh Mint, a Rohaan moment/Moment_Rohaan_Fresh_Mint/loops/drum_loops/full_drum_loops/MO_RO_140_drum_loop_robust_shed.wav"
    runAnalysis(testFilePath)
  }, [])

  return (
    <div className="h-screen w-screen bg-background text-foreground flex flex-col">
      <Menubar>
        <MenubarMenu>
          <MenubarTrigger>File</MenubarTrigger>
          <MenubarContent>
            <MenubarItem>
              New <MenubarShortcut>⌘N</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={handleAnalyze}>
              Open <MenubarShortcut>⌘O</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem>
              Save <MenubarShortcut>⌘S</MenubarShortcut>
            </MenubarItem>
            <MenubarItem>
              Save As... <MenubarShortcut>⇧⌘S</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem>
              Exit <MenubarShortcut>⌘Q</MenubarShortcut>
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger>Edit</MenubarTrigger>
          <MenubarContent>
            <MenubarItem>
              Undo <MenubarShortcut>⌘Z</MenubarShortcut>
            </MenubarItem>
            <MenubarItem>
              Redo <MenubarShortcut>⇧⌘Z</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem>
              Cut <MenubarShortcut>⌘X</MenubarShortcut>
            </MenubarItem>
            <MenubarItem>
              Copy <MenubarShortcut>⌘C</MenubarShortcut>
            </MenubarItem>
            <MenubarItem>
              Paste <MenubarShortcut>⌘V</MenubarShortcut>
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger>View</MenubarTrigger>
          <MenubarContent>
            <MenubarItem>Zoom In</MenubarItem>
            <MenubarItem>Zoom Out</MenubarItem>
            <MenubarSeparator />
            <MenubarItem>Full Screen</MenubarItem>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger>Tools</MenubarTrigger>
          <MenubarContent>
            <MenubarItem>Settings</MenubarItem>
            <MenubarItem>Preferences</MenubarItem>
          </MenubarContent>
        </MenubarMenu>
      </Menubar>

      {/* Main Content Area */}
      <div className="flex-1 bg-background p-4"></div>
    </div>
  )
}

export default App
