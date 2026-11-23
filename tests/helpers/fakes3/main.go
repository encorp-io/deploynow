// A throwaway in-memory S3 server for the backup integration tests.
package main

import (
	"flag"
	"log"
	"net/http"

	"github.com/johannesboyne/gofakes3"
	"github.com/johannesboyne/gofakes3/backend/s3mem"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:9000", "listen")
	flag.Parse()
	backend := s3mem.New()
	faker := gofakes3.New(backend, gofakes3.WithAutoBucket(true))
	log.Fatal(http.ListenAndServe(*addr, faker.Server()))
}
