### curl cmd examples

    curl http://example.com
    curl -I http://example.com
    curl -I -L http://example.com
    curl -v http://example.com
    curl -o mygettext.html http://example.com
    curl -X POST http://example.com -H 'Content-Type:application/json' -d '{"name1": "value1"}'
    curl -X POST http://example.com -H 'Content-Type:application/x-www-form-urlencoded' -d 'k1=v1&k2=v2' 


    cat curl-format.txt 
    \n
           time_namelookup:  %{time_namelookup}\n
              time_connect:  %{time_connect}\n
           time_appconnect:  %{time_appconnect}\n
          time_pretransfer:  %{time_pretransfer}\n
             time_redirect:  %{time_redirect}\n
        time_starttransfer:  %{time_starttransfer}\n
                        ----------\n
                time_total:  %{time_total}\n
    \n

    curl -s -w @curl-format.txt -o /dev/null http://example.com

           time_namelookup:  0.004
              time_connect:  0.166
           time_appconnect:  0.000
          time_pretransfer:  0.166
             time_redirect:  0.000
        time_starttransfer:  0.340
                        ----------
                time_total:  0.340


