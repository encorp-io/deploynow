package agent

import (
	"bufio"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
)

// Metrics describe the host the agent runs on. Inside a container, /proc/loadavg
// and /proc/meminfo show the host's values; the disk is the filesystem holding
// DiskPath (Docker's data root when it is mounted, else the container's root,
// which lives on the same filesystem as Docker's data).
type Metrics struct {
	CPUs         int     `json:"cpus"`
	Load1        float64 `json:"load1"`
	Load5        float64 `json:"load5"`
	MemTotal     uint64  `json:"memTotal"`
	MemAvailable uint64  `json:"memAvailable"`
	DiskPath     string  `json:"diskPath"`
	DiskTotal    uint64  `json:"diskTotal"`
	DiskFree     uint64  `json:"diskFree"`
}

func CollectMetrics(diskPath string) Metrics {
	m := Metrics{CPUs: runtime.NumCPU()}
	if b, err := os.ReadFile("/proc/loadavg"); err == nil {
		f := strings.Fields(string(b))
		if len(f) >= 2 {
			m.Load1, _ = strconv.ParseFloat(f[0], 64)
			m.Load5, _ = strconv.ParseFloat(f[1], 64)
		}
	}
	if f, err := os.Open("/proc/meminfo"); err == nil {
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			parts := strings.Fields(sc.Text())
			if len(parts) < 2 {
				continue
			}
			v, _ := strconv.ParseUint(parts[1], 10, 64)
			switch parts[0] {
			case "MemTotal:":
				m.MemTotal = v * 1024
			case "MemAvailable:":
				m.MemAvailable = v * 1024
			}
		}
		f.Close()
	}
	if diskPath == "" {
		diskPath = "/"
		if _, err := os.Stat("/var/lib/docker"); err == nil {
			diskPath = "/var/lib/docker"
		}
	}
	var st syscall.Statfs_t
	if syscall.Statfs(diskPath, &st) == nil {
		m.DiskPath = diskPath
		m.DiskTotal = st.Blocks * uint64(st.Bsize)
		m.DiskFree = st.Bavail * uint64(st.Bsize)
	}
	return m
}
